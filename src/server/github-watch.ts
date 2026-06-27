import { taskRepo } from "./crud.ts";
import { type CloudPr, bus } from "./events.ts";
import { pullMain } from "./git.ts";
import { reconcile } from "./reconcile.ts";

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
        number url state isDraft merged updatedAt headRefName
        commits(last:1){nodes{commit{statusCheckRollup{state}}}}
      }
    }
  }
}`;

async function gh(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { ok: code === 0, stdout, stderr };
}

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

/** Fetch the current state of every `pm/task-*` PR. Returns [] on any failure
 *  (no gh, no auth, network blip) — a failed tick is non-fatal; we retry next. */
export async function fetchCloudPrs(): Promise<CloudPr[]> {
  const repo = await resolveRepo();
  if (!repo) return [];
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
    return [];
  }
  // biome-ignore lint/suspicious/noExplicitAny: untyped GraphQL JSON, narrowed below.
  let data: any;
  try {
    data = JSON.parse(r.stdout);
  } catch {
    return [];
  }
  const nodes = data?.data?.repository?.pullRequests?.nodes ?? [];
  const prs: CloudPr[] = [];
  for (const n of nodes) {
    const m = BRANCH_RE.exec(n.headRefName ?? "");
    if (!m) continue;
    prs.push({
      taskId: Number(m[1]),
      number: n.number,
      url: n.url,
      state: n.state,
      isDraft: !!n.isDraft,
      merged: !!n.merged,
      checks: n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null,
      headRefName: n.headRefName,
      updatedAt: n.updatedAt,
    });
  }
  return prs;
}

/** Signature of the fields whose change we care about — drives "did this PR
 *  actually change?" so we don't re-emit on irrelevant churn (e.g. updatedAt). */
function sig(pr: CloudPr): string {
  return `${pr.state}|${pr.merged}|${pr.isDraft}|${pr.checks}|${pr.url}`;
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

// ---- the loop --------------------------------------------------------------
let lastByNumber = new Map<number, CloudPr>();

async function tick(initial: boolean): Promise<number> {
  const prs = await fetchCloudPrs();
  // Don't seed/clear on a failed fetch (empty result with nothing prior is
  // indistinguishable, so just no-op until we get data).
  if (prs.length === 0 && lastByNumber.size === 0) return 0;
  const events = diffCloudPrs(lastByNumber, prs);
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
