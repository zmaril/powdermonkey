import { eq, inArray } from "drizzle-orm";
import { AgentState, MergeableState, PrState } from "../shared/types.ts";
import { repoRepo, taskRepo } from "./crud.ts";
import { db } from "./db.ts";
import {
  type AgentStatus,
  bus,
  type CloudEventMeta,
  type CloudPr,
  type FollowupComment,
} from "./events.ts";
import { ingestFollowups } from "./followups.ts";
import { askClaude, gh } from "./gh.ts";
import { pullMain } from "./git.ts";
import {
  clearRebaseAsked,
  isRebaseAsked,
  listPrs,
  markRebaseAsked,
  upsertPrState,
} from "./pr-store.ts";
import { reconcile } from "./reconcile.ts";
import { phases, type Repo, tasks } from "./schema.ts";
import { getAutoRebase } from "./settings.ts";

// The one loop. It polls GitHub for the PRs our cloud workers open — branches
// named `pm/task-<id>-<slug>` — across EVERY registered repo, diffs each tick
// against the last-seen state, and emits typed events on the bus. Independent
// subscribers (below) react; the watcher itself owns no task/session logic.
// A PR's identity is (repo, number): numbers collide freely across repos.
//
// Division of truth:
//   • GitHub PR state is the lifecycle *clock* (dispatched → PR open → merged)
//     and the source of `task.prUrl`.
//   • Commit trailers on `main` stay the *truth* for phase/task completion — a
//     merge event just pulls main and wakes reconcile so it runs promptly instead
//     of on a blind 15s timer.
//
// "Realtime" is efficient polling: GitHub offers no client push for repo events
// short of webhooks (which need a public endpoint — PowderMonkey is localhost).
// A 10s GraphQL poll over `gh` auth costs ~1 point per registered repo of a
// 5000/hr budget and feels live enough. Live agent micro-state (needs-you /
// retry) is deliberately NOT tracked here — that's the Claude web/mobile app's job.

const INTERVAL_MS = Number(process.env.PM_GITHUB_WATCH_INTERVAL_MS ?? 10_000);
// Branch → task id: `pm/task-166-archive-merged-sessions` → 166. Tolerates the
// bare `pm/task-2` form too.
const BRANCH_RE = /^pm\/task-(\d+)(?:-|$)/;

const GQL = `query($owner:String!,$name:String!){
  repository(owner:$owner,name:$name){
    pullRequests(first:100, orderBy:{field:UPDATED_AT, direction:DESC}){
      nodes{
        number title url state isDraft merged mergeable updatedAt headRefName
        checks: commits(last:1){nodes{commit{statusCheckRollup{state}}}}
        history: commits(first:100){nodes{commit{messageBody}}}
        comments(last:30){nodes{databaseId url body updatedAt}}
      }
    }
  }
}`;

/** Fetch the current state of every PR we can tie to a task in ONE registered
 *  repo — by branch name (`pm/task-<id>-…`) or, failing that, its commit trailers
 *  (see resolveTaskId). Returns `null` on a fetch failure (no gh, no auth, network
 *  blip, bad JSON) so the caller can leave that repo's last-known state untouched;
 *  an empty array means the fetch succeeded and there genuinely are no matching
 *  PRs. Exported for the odd manual probe; the loop drives it per registered repo. */
export async function fetchRepoPrs(
  repo: Pick<Repo, "id" | "slug" | "owner" | "name">,
): Promise<CloudPr[] | null> {
  const r = await gh([
    "api",
    "graphql",
    "-f",
    `owner=${repo.owner}`,
    "-f",
    `name=${repo.name}`,
    "-f",
    `query=${GQL}`,
  ]);
  if (!r.ok) {
    console.warn(
      `github-watch: gh graphql failed for ${repo.slug}:`,
      r.stderr.trim().slice(0, 200),
    );
    return null;
  }
  // biome-ignore lint/suspicious/noExplicitAny: untyped GraphQL JSON, narrowed below.
  let data: any;
  try {
    data = JSON.parse(r.stdout);
  } catch {
    return null;
  }
  const nodes = data?.data?.repository?.pullRequests?.nodes ?? [];
  const prs: CloudPr[] = [];
  for (const n of nodes) {
    const commitText = (n.history?.nodes ?? [])
      .map((c: { commit?: { messageBody?: string } }) => c.commit?.messageBody ?? "")
      .join("\n");
    const taskId = await resolveTaskId(n.headRefName ?? "", commitText, repo.id);
    if (taskId == null) continue; // can't tie this PR to a task — skip it
    const lastAgent = lastAgentComment(n.comments?.nodes ?? []);
    prs.push({
      repo: repo.slug,
      taskId,
      number: n.number,
      title: n.title ?? "",
      url: n.url,
      state: n.state,
      isDraft: !!n.isDraft,
      merged: !!n.merged,
      checks: n.checks?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null,
      mergeable: n.mergeable ?? null,
      headRefName: n.headRefName,
      updatedAt: n.updatedAt,
      agent: statusFromComments(n.comments?.nodes ?? []),
      followups: followupsFromComments(n.comments?.nodes ?? []),
      lastComment: lastAgent?.body ?? null,
      lastCommentAt: lastAgent?.updatedAt ?? null,
      lastCommentUrl: lastAgent?.url ?? null,
    });
  }
  return prs;
}

// The marker on a worker's status comment. Cloud workers can't edit comments — the
// cloud environment has no comment-edit tool, only "post a new comment" — so the
// status channel is append-only: the worker POSTs a FRESH comment carrying this marker
// on each update, and github-watch reads the newest marked comment as the current
// status (older marked comments are superseded and ignored). The pile-up of stale
// status comments is fine; the marker + newest-wins is the whole contract. The skill
// tells the worker this.
export const STATUS_MARKER = "<!-- pm:status -->";

// The recognised status words — the AgentState enum is the single source of truth.
const AGENT_STATES = new Set<string>(Object.values(AgentState));

// The footer the cloud agent stamps on its PR comments. It's how we tell the agent's
// OWN messages apart from our `@claude` command comments (which lack it) and any human
// replies — so "last agent comment" is the agent talking, never our asks echoed back.
const AGENT_FOOTER = /generated\s+(?:by|with)\b[\s\S]{0,40}claude code/i;

/** The agent's newest PR comment — the freshest thing it said, footer + status marker
 *  stripped for display, plus its GitHub timestamp. Comments arrive oldest→newest, so the
 *  last footer-bearing one is the most recent. Null when the agent hasn't posted yet.
 *  Pure — exported for tests. */
export function lastAgentComment(
  comments: { body?: string; updatedAt?: string; url?: string }[],
): { body: string; updatedAt: string | null; url: string | null } | null {
  let latest: { body?: string; updatedAt?: string; url?: string } | null = null;
  for (const c of comments) {
    if (AGENT_FOOTER.test(c.body ?? "")) latest = c;
  }
  if (latest == null) return null;
  // Cut the trailing "Generated by/with … Claude Code" footer (and a leading separator),
  // drop the status marker, and trim. Empty after that → null.
  const raw = latest.body ?? "";
  const m = raw.match(/\n*\s*-{0,3}\s*generated\s+(?:by|with)\b/i);
  const body = (m?.index != null ? raw.slice(0, m.index) : raw).replace(STATUS_MARKER, "").trim();
  return body ? { body, updatedAt: latest.updatedAt ?? null, url: latest.url ?? null } : null;
}

/** Parse a worker's sticky status comment into the structured block the UI reads.
 *  Returns null when the comment isn't a status comment (no marker). The body is a
 *  light `key: value` block under the marker — tolerant of markdown noise (`**bold**`,
 *  `- ` list markers) so the worker can format it for humans without breaking the
 *  parse. This is the validation seam between the worker's free text and the typed
 *  domain: a `status:` word outside AgentState resolves to `state: null` (the raw
 *  text still rides in `body`). `updatedAt` is filled in by the caller from the
 *  comment's GitHub timestamp. Pure — exported for tests. */
export function parseStatusComment(body: string): Omit<AgentStatus, "updatedAt"> | null {
  if (!body?.includes(STATUS_MARKER)) return null;
  const fields: Record<string, string> = {};
  for (const raw of body.split(/\r?\n/)) {
    // Strip emphasis/code/quote chars and a leading list marker so `**status:**`,
    // `- status:` and `> status:` all reduce to a plain `key: value`. We pointedly do
    // NOT strip `_`, so a value with underscores — notably the session URL's
    // `session_<id>` — survives intact.
    const line = raw
      .replace(/[*`>]/g, "")
      .replace(/^\s*[-+]\s*/, "")
      .trim();
    const m = line.match(/^(status|summary|next|session)\s*:\s*(.*)$/i);
    if (m) fields[m[1].toLowerCase()] = m[2].trim();
  }
  const word = (fields.status ?? "").toLowerCase();
  return {
    state: AGENT_STATES.has(word) ? (word as AgentState) : null,
    summary: fields.summary || null,
    next: fields.next || null,
    // Pull the bare URL out of the `session:` value, tolerant of a markdown link or
    // autolink wrapping it ([…](url) / <url>) — stops at whitespace or closing bracket.
    sessionUrl: fields.session?.match(/https?:\/\/[^\s)>\]]+/)?.[0] ?? null,
    // The marker line stripped, the rest kept verbatim for the human-readable glance.
    body: body.replace(STATUS_MARKER, "").trim(),
  };
}

/** Pick the worker's status out of a PR's comments: the newest one carrying the marker.
 *  This is the whole read side of the append-only status contract — workers can't edit
 *  comments, so they POST a fresh marked comment per update and the newest one is the
 *  live status; older marked comments are superseded and ignored. Comments arrive
 *  oldest→newest (GitHub returns `comments(last:N)` ascending), so last-parsed-wins
 *  lands on the most recent. Returns null when no comment carries the marker. If we
 *  ever support several agents posting status on one PR, this is the seam to widen —
 *  group the marked comments by their stamped `sessionUrl` instead of collapsing to one.
 *  Exported for tests. */
export function statusFromComments(
  comments: { body?: string; updatedAt?: string }[],
): AgentStatus | null {
  let agent: AgentStatus | null = null;
  for (const c of comments) {
    const parsed = parseStatusComment(c.body ?? "");
    if (parsed) agent = { ...parsed, updatedAt: c.updatedAt ?? null };
  }
  return agent;
}

// The marker that tags a follow-up a cloud worker hands back. Unlike the single
// newest-wins status comment, follow-up comments are append-only: a worker that
// can't reach $PM_URL posts one per follow-up, and the watcher turns each into a
// pending proposal (see followups.ingestFollowups + the skill).
export const FOLLOWUP_MARKER = "<!-- pm:followup -->";

/** Parse a `<!-- pm:followup -->` comment into a follow-up's title + body. Returns
 *  null when the comment isn't a follow-up (no marker). Forgiving of markdown noise
 *  like the status parser: a `title:` line names the title and everything after is the
 *  body; failing an explicit `title:`, the first non-empty line becomes the title and
 *  the rest the body — so a worker can write a keyed block or just a one-liner. An
 *  optional leading `body:` label on the remainder is stripped. Pure — exported for tests. */
export function parseFollowupComment(raw: string): { title: string; body: string } | null {
  if (!raw?.includes(FOLLOWUP_MARKER)) return null;
  const clean = (s: string) =>
    s
      .replace(/[*`>]/g, "")
      .replace(/^\s*[-+]\s*/, "")
      .trim();
  let title = "";
  const bodyLines: string[] = [];
  for (const line of raw.replace(FOLLOWUP_MARKER, "").split(/\r?\n/)) {
    if (!title) {
      const c = clean(line);
      const m = c.match(/^title\s*:\s*(.*)$/i);
      if (m) {
        title = m[1].trim();
        continue;
      }
      if (c) {
        title = c; // no `title:` key — adopt the first non-empty line as the title
        continue;
      }
      continue; // leading blank line
    }
    bodyLines.push(line);
  }
  if (!title) return null; // marker but nothing usable
  const body = bodyLines
    .join("\n")
    .trim()
    .replace(/^\s*body\s*:\s*/i, "")
    .trim();
  return { title, body };
}

/** Collect every follow-up comment on a PR (append-only, so all of them, not just the
 *  latest). Carries each comment's databaseId through as the ingest dedup key. */
function followupsFromComments(
  comments: { databaseId?: number; body?: string; updatedAt?: string }[],
): FollowupComment[] {
  const out: FollowupComment[] = [];
  for (const c of comments) {
    const parsed = parseFollowupComment(c.body ?? "");
    if (parsed)
      out.push({ commentId: c.databaseId ?? null, ...parsed, updatedAt: c.updatedAt ?? null });
  }
  return out;
}

/** Pull `PM-Task:` / `PM-Phase:` ids out of commit-trailer text (the same trailers
 *  reconciliation reads off main). Each may be repeated or comma/space-separated.
 *  Pure — exported for tests. */
export function parseTrailerIds(text: string): { taskIds: number[]; phaseIds: number[] } {
  const grab = (key: string): number[] => {
    const ids: number[] = [];
    const re = new RegExp(`^\\s*${key}:\\s*(.+)$`, "gim");
    for (const m of text.matchAll(re)) {
      for (const part of m[1].split(/[\s,]+/)) {
        const id = Number(part);
        if (Number.isInteger(id) && id > 0) ids.push(id);
      }
    }
    return ids;
  };
  return { taskIds: grab("PM-Task"), phaseIds: grab("PM-Phase") };
}

async function taskIdForPhaseIds(ids: number[]): Promise<number | null> {
  if (ids.length === 0) return null;
  const rows = await db
    .select({ taskId: phases.taskId })
    .from(phases)
    .where(inArray(phases.id, ids));
  return rows[0]?.taskId ?? null;
}

/** May task `taskId` own a PR observed in repo `repoId`? True when the task is
 *  unknown locally (tolerated — persistence must not depend on the row existing),
 *  repo-less (the pre-registry path), or pinned to that very repo. False only for
 *  a task pinned elsewhere: with several repos watched, branch names and trailer
 *  ids can collide across repos, and a PR must never claim another repo's task. */
async function taskInRepo(taskId: number, repoId: number): Promise<boolean> {
  const [t] = await db.select({ repoId: tasks.repoId }).from(tasks).where(eq(tasks.id, taskId));
  return !t || t.repoId == null || t.repoId === repoId;
}

/** Map a PR to its task. The branch name (`pm/task-<id>-…`) is the happy path, but
 *  cloud workers don't always follow it (e.g. a default `claude/…` branch). When
 *  the branch carries no id, fall back to the commit trailers, which always do:
 *  a `PM-Task:` names the task directly; a `PM-Phase:` resolves through the DB.
 *  Every candidate passes the taskInRepo guard — a resolution that points at a
 *  task pinned to a different repo is rejected (falling through to the next
 *  candidate) rather than mis-tying the PR. Exported for tests. */
export async function resolveTaskId(
  headRefName: string,
  commitText: string,
  repoId: number,
): Promise<number | null> {
  const m = BRANCH_RE.exec(headRefName);
  if (m && (await taskInRepo(Number(m[1]), repoId))) return Number(m[1]);
  const { taskIds, phaseIds } = parseTrailerIds(commitText);
  for (const id of taskIds) if (await taskInRepo(id, repoId)) return id;
  const viaPhase = await taskIdForPhaseIds(phaseIds);
  if (viaPhase != null && (await taskInRepo(viaPhase, repoId))) return viaPhase;
  return null;
}

/** Signature of the fields whose change we care about — drives "did this PR
 *  actually change?" so we don't re-emit on irrelevant churn (e.g. the PR's own
 *  updatedAt). The newest status comment's own timestamp (`agent.updatedAt`) is
 *  included so a fresh status comment counts as a change — that's what makes the new
 *  status persist (the upsert runs on changed PRs) and reach the UI — without
 *  reacting to unrelated PR churn. */
function sig(pr: CloudPr): string {
  // The follow-up comment ids are folded in so a freshly-posted `<!-- pm:followup -->`
  // comment counts as a change — that's what wakes the ingest subscriber to slurp it.
  const followups = pr.followups.map((f) => f.commentId ?? "?").join("+");
  return `${pr.state}|${pr.merged}|${pr.isDraft}|${pr.checks}|${pr.mergeable}|${pr.url}|${pr.agent?.updatedAt ?? ""}|${followups}`;
}

export type CloudEventType = "pr.opened" | "pr.updated" | "pr.merged" | "pr.closed";
export type CloudEvent = { type: CloudEventType; pr: CloudPr };

/** A PR's identity across the watched repos — `number` alone collides once more
 *  than one repo is polled. Keys the last-seen map and the diff. Exported for tests. */
export function prKey(pr: Pick<CloudPr, "repo" | "number">): string {
  return `${pr.repo}#${pr.number}`;
}

/** Pure diff: given the previously-seen PRs (keyed by prKey) and the freshly
 *  fetched set, return the events to emit. Exported for tests; mutates nothing.
 *  A PR seen for the first time is classified by its current state — which is how
 *  the startup catch-up (empty `prev`) replays existing PRs as their real state. */
export function diffCloudPrs(prev: Map<string, CloudPr>, next: CloudPr[]): CloudEvent[] {
  const events: CloudEvent[] = [];
  for (const pr of next) {
    const before = prev.get(prKey(pr));
    if (!before) {
      if (pr.merged) events.push({ type: "pr.merged", pr });
      else if (pr.state === PrState.Closed) events.push({ type: "pr.closed", pr });
      else events.push({ type: "pr.opened", pr });
      continue;
    }
    if (sig(before) === sig(pr)) continue; // nothing we track moved
    if (pr.merged && !before.merged) events.push({ type: "pr.merged", pr });
    else if (pr.state === PrState.Closed && before.state !== PrState.Closed && !pr.merged)
      events.push({ type: "pr.closed", pr });
    else events.push({ type: "pr.updated", pr });
  }
  return events;
}

// ---- auto-rebase ask -------------------------------------------------------
// When a task PR drifts into conflict with main, ask its live cloud session to
// rebase — via an @claude comment (see gh.ts). The hard part is *idempotency*:
// one ask per conflict, never a re-spam. GitHub's `mergeable` is a three-state
// signal (CONFLICTING / MERGEABLE / UNKNOWN-or-null, the last meaning "not yet
// computed"), so we track which PRs we've already pinged and decide from the
// transition, not the raw state.

/** Pure: decide what to do about a PR's merge state, given whether we've already
 *  asked it to rebase this episode and whether this is a startup-catch-up (`initial`)
 *  event. Folding `initial` in here keeps the whole decision testable.
 *   • MERGEABLE                         → "clear" (episode over; a *future* conflict
 *       re-asks). Runs even on `initial`, so a conflict resolved while we were down
 *       reconciles the ledger on boot — otherwise a stale "asked" flag would suppress
 *       the *next* real conflict.
 *   • CONFLICTING + already asked        → "skip" (don't re-spam the same conflict)
 *   • CONFLICTING + initial              → "skip" (don't re-ask pre-boot conflicts on
 *       a restart, nor flood on the first-ever catch-up)
 *   • CONFLICTING + fresh, live          → "ask"
 *   • UNKNOWN / null                     → "skip" (transient; leave the ledger as-is)
 *  Exported for tests. */
export function rebaseAction(
  mergeable: MergeableState | null,
  alreadyAsked: boolean,
  initial: boolean,
): "ask" | "clear" | "skip" {
  if (mergeable === MergeableState.Mergeable) return "clear";
  if (mergeable !== MergeableState.Conflicting) return "skip";
  if (alreadyAsked || initial) return "skip";
  return "ask";
}

const REBASE_MESSAGE =
  "This PR has merge conflicts with `main`. Please rebase onto the latest `main`, " +
  "resolve the conflicts, and push — keeping the PM-Phase / PM-Task trailers intact.";

// The auto-rebase toggle is a persisted operator setting (see settings.ts) —
// `getAutoRebase()` reads it off an in-memory cache, so this hot path stays sync.
// It gates only the *ask*; the ledger housekeeping (clearing a resolved conflict)
// still runs below, so toggling it back on never asks stale.

// Idempotency now lives in the pull_requests table (rebaseAskedAt), not memory, so
// the "we already asked" fact survives a restart — closing a real re-spam window:
// after a restart an in-memory set was empty, so any sig change while a PR stayed
// CONFLICTING would ask again. Because the ledger is durable, the `initial` skip is
// scoped to the *ask* alone (in rebaseAction); a MERGEABLE seen during catch-up
// still clears, so a conflict resolved during downtime can't leave a stale flag.
async function maybeAskRebase(pr: CloudPr, meta: CloudEventMeta): Promise<void> {
  const action = rebaseAction(pr.mergeable, await isRebaseAsked(pr.repo, pr.number), meta.initial);
  if (action === "clear") {
    await clearRebaseAsked(pr.repo, pr.number);
    return;
  }
  if (action !== "ask") return;
  if (!getAutoRebase()) return; // operator paused auto-rebase — drive it by hand
  await markRebaseAsked(pr.repo, pr.number); // mark first, so a failed post doesn't loop-retry
  const r = await askClaude(pr.number, REBASE_MESSAGE, pr.repo);
  if (r.ok) {
    console.log(`github-watch: ${pr.repo}#${pr.number} conflicting → asked @claude to rebase`);
  } else {
    await clearRebaseAsked(pr.repo, pr.number); // post failed — let a later tick retry
    console.warn(
      `github-watch: rebase ask for ${pr.repo}#${pr.number} failed:`,
      r.stderr.trim().slice(0, 200),
    );
  }
}

// ---- the loop --------------------------------------------------------------
let lastByKey = new Map<string, CloudPr>();

/** The watcher's latest known PR state, one per task-linked PR. Served to the UI
 *  (GET /cloud-prs) for the Active panel's CI / merge-conflict badges. Read from
 *  the pull_requests table, so it's populated immediately on boot from last-known
 *  state — before the first poll lands. */
export function currentCloudPrs(): Promise<CloudPr[]> {
  return listPrs();
}

async function tick(initial: boolean): Promise<number> {
  // One GraphQL fetch per live registered repo. A repo whose fetch fails carries
  // its last-known PRs forward untouched — identical entries diff to nothing, so
  // a blip never re-classifies (or silently drops) that repo's PRs, while the
  // repos that did fetch still emit their changes.
  const next = new Map<string, CloudPr>();
  for (const repo of await repoRepo.list()) {
    const prs = await fetchRepoPrs(repo);
    if (prs === null) {
      for (const [k, p] of lastByKey) if (p.repo === repo.slug) next.set(k, p);
      continue;
    }
    for (const p of prs) next.set(prKey(p), p);
  }
  const events = diffCloudPrs(lastByKey, [...next.values()]);
  // Persist the changed PRs *before* emitting, so their rows exist when the rebase
  // subscriber reads/writes the ask ledger. upsertPrState only writes cache
  // columns — it never disturbs rebaseAskedAt. Unchanged PRs already have a row
  // from a prior tick, so we skip the write churn for them.
  for (const ev of events) await upsertPrState(ev.pr);
  for (const ev of events) await bus.emit(ev.type, ev.pr, { initial });
  lastByKey = next;
  return events.length;
}

/** Run one catch-up pass immediately (e.g. POST /github-sync). Uses the same diff,
 *  so it only acts on real changes since the last tick. */
export async function syncCloudPrs(): Promise<{ tracked: number; emitted: number }> {
  const emitted = await tick(false);
  return { tracked: lastByKey.size, emitted };
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

/** Start the poll loop (no-op if disabled via PM_GITHUB_WATCH_INTERVAL_MS=0 or
 *  already started). The first tick is the startup catch-up: `lastByKey` is
 *  empty, so every existing PR is seen as new and its current state applied —
 *  this is how PRs opened/merged before boot get picked up. It's tagged
 *  initial:true so notify-style subscribers can stay quiet about old PRs. */
export function startGithubWatch(): void {
  if (INTERVAL_MS <= 0 || timer) return;
  registerSubscribers();
  void tick(true).catch((e) =>
    console.warn("github-watch: initial sync failed:", e instanceof Error ? e.message : e),
  );
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await tick(false);
    } catch (e) {
      console.warn("github-watch: tick failed:", e instanceof Error ? e.message : e);
    } finally {
      running = false;
    }
  }, INTERVAL_MS);
}

// ---- default subscribers ---------------------------------------------------
// The event seam the operator asked for: independent reactions to the one loop.
// Add more anywhere with `bus.on(...)`; none of these know about each other.
let subscribed = false;
function registerSubscribers(): void {
  if (subscribed) return;
  subscribed = true;

  // Enricher: keep task.prUrl current whenever a matching PR appears or changes.
  const enrich = async (pr: CloudPr) => {
    const task = await taskRepo.get(pr.taskId);
    if (task && task.prUrl !== pr.url) await taskRepo.update(pr.taskId, { prUrl: pr.url });
  };
  bus.on("pr.opened", enrich);
  bus.on("pr.updated", enrich);
  bus.on("pr.merged", enrich);

  // Slurp follow-ups: a `<!-- pm:followup -->` comment a cloud worker left becomes a
  // pending `create task` proposal (see followups.ts). Idempotent by comment id, so it
  // runs on every event — including the startup catch-up — without ever duplicating.
  // The cloud counterpart to a local worker POSTing /followups.
  const ingest = async (pr: CloudPr) => {
    const n = await ingestFollowups(pr);
    if (n > 0) console.log(`github-watch: PR #${pr.number} → ${n} follow-up(s) → proposals`);
  };
  bus.on("pr.opened", ingest);
  bus.on("pr.updated", ingest);
  bus.on("pr.merged", ingest);

  // Auto-rebase: a PR that becomes CONFLICTING gets one @claude rebase ask. Both
  // first-sight (pr.opened) and live drift (pr.updated) can surface the conflict;
  // maybeAskRebase dedupes so only the first per episode actually comments.
  bus.on("pr.opened", maybeAskRebase);
  bus.on("pr.updated", maybeAskRebase);
  // A PR leaving the board ends its conflict episode — clear the ledger so a reopen
  // starts clean.
  const forget = (pr: CloudPr) => clearRebaseAsked(pr.repo, pr.number);
  bus.on("pr.merged", forget);
  bus.on("pr.closed", forget);

  // Merge → reconcile. Coalesced: a tick can surface several merges at once (and
  // the startup sync surfaces every past merge), so we debounce to a single
  // pull-main + reconcile rather than one per PR. GitHub is the clock; the trailer
  // scan on main is what actually marks phases done.
  bus.on("pr.merged", scheduleReconcile);
}

let reconcilePending = false;
function scheduleReconcile(): void {
  if (reconcilePending) return;
  reconcilePending = true;
  // setTimeout(0) fires after the current tick finishes emitting, collapsing all
  // of this tick's pr.merged events into one reconcile.
  setTimeout(async () => {
    reconcilePending = false;
    try {
      await pullMain();
      const r = await reconcile();
      if (r.phasesMarked > 0 || r.tasksCompleted > 0)
        console.log(
          `github-watch: merge → reconciled ${r.phasesMarked} phase(s), ${r.tasksCompleted} task(s)`,
        );
    } catch (e) {
      console.warn(
        "github-watch: post-merge reconcile failed:",
        e instanceof Error ? e.message : e,
      );
    }
  }, 0);
}
