import type { Session, Task } from "../../server/schema.ts";
import { type SessionKind, SessionState, TaskStatus } from "../../shared/types.ts";
import type { Ghost, GroupedGhosts } from "../ghosts.ts";
import type { Indexes } from "../plan-data.ts";

// Pure filter/search core for the two reframed panes (Sessions, Tasks). Both panes
// now show live AND history in one list, sliced by the same kind of controls — a
// text search, a status bucket, an environment (local/cloud), a goal/milestone
// scope, and a starred toggle. The buckets and predicates live here, free of React,
// so the matching logic is unit-testable and the panes just render the result.
//
// The bucket *values* are deliberately UI vocabulary, NOT the wire enums
// (TaskStatus/SessionState) — a task's "backlog" or a session's "landed" is a
// derived lifecycle the operator filters on, distinct from the stored status word.
// Comparisons against the stored state use the enums (SessionState/TaskStatus).

type ValueOf<T> = T[keyof T];

/** "all" — the wildcard a status/env filter uses to mean "don't filter on this axis". */
export const ANY = "all" as const;
export type Any = typeof ANY;

// ── Goal / milestone scope ───────────────────────────────────────────────────────
// The scope control is a single Select whose value encodes goal vs milestone as
// "g:<id>" / "m:<id>" (or ANY). The filter itself stores the two ids; these translate
// between the Select value and that pair, and build the grouped option list. Kept here
// (not in the control) so the encoding is testable and shared by both panes.

type ScopeOption = { value: string; label: string };
type ScopeGroup = { group: string; items: ScopeOption[] };

/** Grouped goal/milestone options for the scope Select: a leading "Any goal", then one
 *  group per goal with a "<goal> — all" entry and each of its milestones. */
export function scopeOptions(idx: Indexes): (ScopeOption | ScopeGroup)[] {
  const out: (ScopeOption | ScopeGroup)[] = [{ value: ANY, label: "Any goal" }];
  for (const g of [...idx.goals].sort((a, b) => a.id - b.id)) {
    const items: ScopeOption[] = [{ value: `g:${g.id}`, label: `${g.title} — all` }];
    for (const m of idx.milestonesByGoal.get(g.id) ?? []) {
      items.push({ value: `m:${m.id}`, label: m.title });
    }
    out.push({ group: g.title, items });
  }
  return out;
}

/** Decode a scope Select value into the goal/milestone id pair the filter stores. */
export function parseScope(scope: string): { goalId: number | null; milestoneId: number | null } {
  if (scope.startsWith("g:")) return { goalId: Number(scope.slice(2)), milestoneId: null };
  if (scope.startsWith("m:")) return { goalId: null, milestoneId: Number(scope.slice(2)) };
  return { goalId: null, milestoneId: null };
}

/** Encode the filter's goal/milestone id pair back into the scope Select value. */
export function scopeValue(f: { goalId: number | null; milestoneId: number | null }): string {
  if (f.milestoneId != null) return `m:${f.milestoneId}`;
  if (f.goalId != null) return `g:${f.goalId}`;
  return ANY;
}

// ── Window repo scope ────────────────────────────────────────────────────────────
// The active window's ambient scope (windows.ts, docs/windows.md), layered UNDER the
// FilterBar: the panes only ever see plan rows whose repo is on one of the window's
// tabs, and the FilterBar refines within that. Empty = an unscoped window — it sees
// everything. Union semantics: a window watching three repos shows all three at once.

/** True when a task is on one of the window's repo tabs. Nothing is repo-less by
 *  policy (the boot seed backfills), but a null repoId that slips through is out of
 *  every scoped window — it's on no tab. */
export function taskInScope(task: Task, repoIds: number[]): boolean {
  return repoIds.length === 0 || (task.repoId != null && repoIds.includes(task.repoId));
}

/** A session reaches the scope through its tasks (it has no repo of its own — one
 *  session runs one repo, via its task). `tasks` are the session's own, from
 *  idx.tasksBySession. A task-less session only shows in an unscoped window. */
export function sessionInScope(tasks: Task[], repoIds: number[]): boolean {
  return repoIds.length === 0 || tasks.some((t) => taskInScope(t, repoIds));
}

// ── Tasks ──────────────────────────────────────────────────────────────────────

/** A task's derived lifecycle bucket — the axis the Tasks pane filters on. One task
 *  is in exactly one bucket. Folds the old Archive tab in: `Finished` (merged),
 *  `WontDo` (cancelled), and `Archived` (filed away) are just bucket values now. */
export const TaskBucket = {
  Backlog: "backlog", // to-be-worked: no live session, not done/cancelled/archived
  Active: "active", // has a live session running right now
  Finished: "finished", // merged — landed on main
  WontDo: "wontdo", // cancelled — closed as won't-do
  Archived: "archived", // soft-deleted (archived_at) without being finished/cancelled
} as const;
export type TaskBucket = ValueOf<typeof TaskBucket>;

/** Which bucket a task falls in. Terminal status wins over archived/active state, so a
 *  merged-then-archived task still reads as Finished. */
export function taskBucket(task: Task, activeIds: Set<number>): TaskBucket {
  if (task.status === TaskStatus.Merged) return TaskBucket.Finished;
  if (task.status === TaskStatus.Cancelled) return TaskBucket.WontDo;
  if (task.archivedAt != null) return TaskBucket.Archived;
  if (activeIds.has(task.id)) return TaskBucket.Active;
  return TaskBucket.Backlog;
}

export type TaskFilter = {
  search: string;
  status: TaskBucket | Any;
  env: SessionKind | Any;
  goalId: number | null;
  milestoneId: number | null;
  starred: boolean;
};

/** Sessions open to running, Tasks to backlog — so the reframed panes still come up
 *  showing exactly what Active/Backlog showed before. */
export const DEFAULT_TASK_FILTER: TaskFilter = {
  search: "",
  status: TaskBucket.Backlog,
  env: ANY,
  goalId: null,
  milestoneId: null,
  starred: false,
};

/** Whether a needle is a substring of any of the haystack fields (case-insensitive,
 *  trimmed). Empty needle matches everything. */
function hit(search: string, fields: (string | null | undefined)[]): boolean {
  const q = search.trim().toLowerCase();
  if (!q) return true;
  return fields.some((f) => f?.toLowerCase().includes(q));
}

/** True when a task passes every active axis of the filter. */
export function matchTask(
  task: Task,
  idx: Indexes,
  activeIds: Set<number>,
  f: TaskFilter,
): boolean {
  if (f.status !== ANY && taskBucket(task, activeIds) !== f.status) return false;
  if (f.starred && !task.starred) return false;
  if (f.milestoneId != null) {
    if (task.milestoneId !== f.milestoneId) return false;
  } else if (f.goalId != null) {
    const m = idx.milestoneById.get(task.milestoneId);
    if (!m || m.goalId !== f.goalId) return false;
  }
  if (f.env !== ANY) {
    const s = idx.sessionByTask.get(task.id);
    if (!s || s.kind !== f.env) return false;
  }
  return hit(f.search, [`t${task.id}`, String(task.id), task.title]);
}

// ── Proposal ghosts ──────────────────────────────────────────────────────────────
// A ghost is a proposed NEW node (a create) previewed in place — so it's not a real,
// stored task and most of the Tasks filter axes don't apply to it: it has no lifecycle
// bucket, no session/env, and no starred flag. Only the two axes that DO make sense on a
// not-yet-real node reach it: the text search (always), matched on its title the same way
// a task matches (a ghost has no id yet, so title is the only field). Filtering happens
// only on the STANDALONE ghosts the board renders on their own (task / milestone / goal);
// phase ghosts ride inside their task card and are gated by that card, not here.

/** True when a ghost passes the axes that apply to a proposed new node — currently just
 *  the text search, on its title (reusing the same hit() a task matches on). */
export function matchGhost(g: Ghost, _idx: Indexes, f: TaskFilter): boolean {
  return hit(f.search, [g.title]);
}

/** The grouped ghosts sliced by the active filter: each standalone-ghost list (tasks under
 *  a milestone, milestones under a goal, brand-new goals) keeps only the ghosts that match,
 *  dropping any now-empty bucket. Phase ghosts pass through untouched — they render inside a
 *  task card, so they ride with (and are gated by) that card, just like its edit strips. */
export function filterGhosts(ghosts: GroupedGhosts, idx: Indexes, f: TaskFilter): GroupedGhosts {
  const keep = (g: Ghost) => matchGhost(g, idx, f);
  const filterMap = (m: Map<number, Ghost[]>): Map<number, Ghost[]> => {
    const out = new Map<number, Ghost[]>();
    for (const [k, gs] of m) {
      const kept = gs.filter(keep);
      if (kept.length > 0) out.set(k, kept);
    }
    return out;
  };
  return {
    tasksByMilestone: filterMap(ghosts.tasksByMilestone),
    milestonesByGoal: filterMap(ghosts.milestonesByGoal),
    phasesByTask: ghosts.phasesByTask,
    goals: ghosts.goals.filter(keep),
  };
}

// ── Sessions ─────────────────────────────────────────────────────────────────────

/** A session's derived outcome — the axis the Sessions pane filters on. `Live` is a
 *  running (or waiting / needs-you) session; once it's archived it's either `Landed`
 *  (graceful land or teleport → idle) or `Aborted` (operator stop → stopped). */
export const SessionBucket = {
  Live: "live",
  Landed: "landed",
  Aborted: "aborted",
} as const;
export type SessionBucket = ValueOf<typeof SessionBucket>;

export function sessionBucket(s: Session): SessionBucket {
  if (s.archivedAt == null) return SessionBucket.Live;
  if (s.state === SessionState.Stopped) return SessionBucket.Aborted;
  return SessionBucket.Landed;
}

export type SessionFilter = {
  search: string;
  status: SessionBucket | Any;
  kind: SessionKind | Any;
  goalId: number | null;
  milestoneId: number | null;
  starred: boolean;
};

export const DEFAULT_SESSION_FILTER: SessionFilter = {
  search: "",
  status: SessionBucket.Live,
  kind: ANY,
  goalId: null,
  milestoneId: null,
  starred: false,
};

/** True when a session passes every active axis. `tasks` are the session's own (from
 *  idx.tasksBySession) — goal/milestone/starred/text all reach through them, since a
 *  session has no goal of its own. */
export function matchSession(
  session: Session,
  tasks: Task[],
  idx: Indexes,
  f: SessionFilter,
): boolean {
  if (f.status !== ANY && sessionBucket(session) !== f.status) return false;
  if (f.kind !== ANY && session.kind !== f.kind) return false;
  if (f.starred && !tasks.some((t) => t.starred)) return false;
  if (f.milestoneId != null) {
    if (!tasks.some((t) => t.milestoneId === f.milestoneId)) return false;
  } else if (f.goalId != null) {
    const underGoal = tasks.some((t) => idx.milestoneById.get(t.milestoneId)?.goalId === f.goalId);
    if (!underGoal) return false;
  }
  return hit(f.search, [
    `s${session.id}`,
    String(session.id),
    session.branch,
    ...tasks.flatMap((t) => [`t${t.id}`, String(t.id), t.title]),
  ]);
}
