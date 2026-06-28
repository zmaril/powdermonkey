import { inArray } from "drizzle-orm";
import { taskRepo } from "./crud.ts";
import { db } from "./db.ts";
import { type CloudEventMeta, type CloudPr, bus } from "./events.ts";
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
import { phases } from "./schema.ts";

// The one loop. It polls GitHub for the PRs our cloud workers open — branches
// named `pm/task-<id>-<slug>` — diffs each tick against the last-seen state, and
// emits typed events on the bus. Independent subscribers (below) react; the
// watcher itself owns no task/session logic.
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
// A 10s GraphQL poll over `gh` auth costs ~1 point of a 5000/hr budget and feels
// live enough. Live agent micro-state (needs-you / retry) is deliberately NOT
// tracked here — that's the Claude web/mobile app's job.

const INTERVAL_MS = Number(process.env.PM_GITHUB_WATCH_INTERVAL_MS ?? 10_000);
// Branch → task id: `pm/task-166-archive-merged-sessions` → 166. Tolerates the
// bare `pm/task-2` form too.
const BRANCH_RE = /^pm\/task-(\d+)(?:-|$)/;

const GQL = `query($owner:String!,$name:String!){
  repository(owner:$owner,name:$name){
    pullRequests(first:100, orderBy:{field:UPDATED_AT, direction:DESC}){
      nodes{
        number url state isDraft merged mergeable updatedAt headRefName
        checks: commits(last:1){nodes{commit{statusCheckRollup{state}}}}
        history: commits(first:100){nodes{commit{messageBody}}}
      }
    }
  }
}`;

let repoSlug: { owner: string; name: string } | null = null;
/** owner/name from $PM_GITHUB_REPO, else `gh repo view`. Cached after first hit. */
async function resolveRepo(): Promise<{ owner: string; name: string } | null> {
  if (repoSlug) return repoSlug;
  let slug = process.env.PM_GITHUB_REPO;
  if (!slug) {
    const r = await gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]);
    if (r.ok) slug = r.stdout.trim();
  }
  if (!slug?.includes("/")) return null;
  const [owner, name] = slug.split("/");
  repoSlug = { owner, name };
  return repoSlug;
}

/** Fetch the current state of every PR we can tie to a task — by branch name
 *  (`pm/task-<id>-…`) or, failing that, its commit trailers (see resolveTaskId).
 *  Returns `null` on a fetch failure (no gh, no auth, network blip, bad JSON) so
 *  the caller can leave the last-known state untouched; an empty array means the
 *  fetch succeeded and there genuinely are no matching PRs. */
export async function fetchCloudPrs(): Promise<CloudPr[] | null> {
  const repo = await resolveRepo();
  if (!repo) return null;
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
    console.warn("github-watch: gh graphql failed:", r.stderr.trim().slice(0, 200));
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
    const taskId = await resolveTaskId(n.headRefName ?? "", commitText);
    if (taskId == null) continue; // can't tie this PR to a task — skip it
    prs.push({
      taskId,
      number: n.number,
      url: n.url,
      state: n.state,
      isDraft: !!n.isDraft,
      merged: !!n.merged,
      checks: n.checks?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null,
      mergeable: n.mergeable ?? null,
      headRefName: n.headRefName,
      updatedAt: n.updatedAt,
    });
  }
  return prs;
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

/** Map a PR to its task. The branch name (`pm/task-<id>-…`) is the happy path, but
 *  cloud workers don't always follow it (e.g. a default `claude/…` branch). When
 *  the branch carries no id, fall back to the commit trailers, which always do:
 *  a `PM-Task:` names the task directly; a `PM-Phase:` resolves through the DB. */
async function resolveTaskId(headRefName: string, commitText: string): Promise<number | null> {
  const m = BRANCH_RE.exec(headRefName);
  if (m) return Number(m[1]);
  const { taskIds, phaseIds } = parseTrailerIds(commitText);
  if (taskIds.length > 0) return taskIds[0];
  return taskIdForPhaseIds(phaseIds);
}

/** Signature of the fields whose change we care about — drives "did this PR
 *  actually change?" so we don't re-emit on irrelevant churn (e.g. updatedAt). */
function sig(pr: CloudPr): string {
  return `${pr.state}|${pr.merged}|${pr.isDraft}|${pr.checks}|${pr.mergeable}|${pr.url}`;
}

export type CloudEventType = "pr.opened" | "pr.updated" | "pr.merged" | "pr.closed";
export type CloudEvent = { type: CloudEventType; pr: CloudPr };

/** Pure diff: given the previously-seen PRs (keyed by number) and the freshly
 *  fetched set, return the events to emit. Exported for tests; mutates nothing.
 *  A PR seen for the first time is classified by its current state — which is how
 *  the startup catch-up (empty `prev`) replays existing PRs as their real state. */
export function diffCloudPrs(prev: Map<number, CloudPr>, next: CloudPr[]): CloudEvent[] {
  const events: CloudEvent[] = [];
  for (const pr of next) {
    const before = prev.get(pr.number);
    if (!before) {
      if (pr.merged) events.push({ type: "pr.merged", pr });
      else if (pr.state === "CLOSED") events.push({ type: "pr.closed", pr });
      else events.push({ type: "pr.opened", pr });
      continue;
    }
    if (sig(before) === sig(pr)) continue; // nothing we track moved
    if (pr.merged && !before.merged) events.push({ type: "pr.merged", pr });
    else if (pr.state === "CLOSED" && before.state !== "CLOSED" && !pr.merged)
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
  mergeable: string | null,
  alreadyAsked: boolean,
  initial: boolean,
): "ask" | "clear" | "skip" {
  if (mergeable === "MERGEABLE") return "clear";
  if (mergeable !== "CONFLICTING") return "skip";
  if (alreadyAsked || initial) return "skip";
  return "ask";
}

const REBASE_MESSAGE =
  "This PR has merge conflicts with `main`. Please rebase onto the latest `main`, " +
  "resolve the conflicts, and push — keeping the PM-Phase / PM-Task trailers intact.";

// Idempotency now lives in the pull_requests table (rebaseAskedAt), not memory, so
// the "we already asked" fact survives a restart — closing a real re-spam window:
// after a restart an in-memory set was empty, so any sig change while a PR stayed
// CONFLICTING would ask again. Because the ledger is durable, the `initial` skip is
// scoped to the *ask* alone (in rebaseAction); a MERGEABLE seen during catch-up
// still clears, so a conflict resolved during downtime can't leave a stale flag.
async function maybeAskRebase(pr: CloudPr, meta: CloudEventMeta): Promise<void> {
  const action = rebaseAction(pr.mergeable, await isRebaseAsked(pr.number), meta.initial);
  if (action === "clear") {
    await clearRebaseAsked(pr.number);
    return;
  }
  if (action !== "ask") return;
  await markRebaseAsked(pr.number); // mark first, so a failed post doesn't loop-retry
  const repo = await resolveRepo();
  const slug = repo ? `${repo.owner}/${repo.name}` : undefined;
  const r = await askClaude(pr.number, REBASE_MESSAGE, slug);
  if (r.ok) {
    console.log(`github-watch: PR #${pr.number} conflicting → asked @claude to rebase`);
  } else {
    await clearRebaseAsked(pr.number); // post failed — let a later tick retry
    console.warn(
      `github-watch: rebase ask for PR #${pr.number} failed:`,
      r.stderr.trim().slice(0, 200),
    );
  }
}

// ---- the loop --------------------------------------------------------------
let lastByNumber = new Map<number, CloudPr>();

/** The watcher's latest known PR state, one per task-linked PR. Served to the UI
 *  (GET /cloud-prs) for the Active panel's CI / merge-conflict badges. Read from
 *  the pull_requests table, so it's populated immediately on boot from last-known
 *  state — before the first poll lands. */
export function currentCloudPrs(): Promise<CloudPr[]> {
  return listPrs();
}

async function tick(initial: boolean): Promise<number> {
  const prs = await fetchCloudPrs();
  if (prs === null) return 0; // fetch failed — keep last-known state untouched
  const events = diffCloudPrs(lastByNumber, prs);
  // Persist the changed PRs *before* emitting, so their rows exist when the rebase
  // subscriber reads/writes the ask ledger. upsertPrState only writes cache
  // columns — it never disturbs rebaseAskedAt. Unchanged PRs already have a row
  // from a prior tick, so we skip the write churn for them.
  for (const ev of events) await upsertPrState(ev.pr);
  for (const ev of events) await bus.emit(ev.type, ev.pr, { initial });
  lastByNumber = new Map(prs.map((p) => [p.number, p]));
  return events.length;
}

/** Run one catch-up pass immediately (e.g. POST /github-sync). Uses the same diff,
 *  so it only acts on real changes since the last tick. */
export async function syncCloudPrs(): Promise<{ tracked: number; emitted: number }> {
  const emitted = await tick(false);
  return { tracked: lastByNumber.size, emitted };
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

/** Start the poll loop (no-op if disabled via PM_GITHUB_WATCH_INTERVAL_MS=0 or
 *  already started). The first tick is the startup catch-up: `lastByNumber` is
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

  // Auto-rebase: a PR that becomes CONFLICTING gets one @claude rebase ask. Both
  // first-sight (pr.opened) and live drift (pr.updated) can surface the conflict;
  // maybeAskRebase dedupes so only the first per episode actually comments.
  bus.on("pr.opened", maybeAskRebase);
  bus.on("pr.updated", maybeAskRebase);
  // A PR leaving the board ends its conflict episode — clear the ledger so a reopen
  // starts clean.
  const forget = (pr: CloudPr) => clearRebaseAsked(pr.number);
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
