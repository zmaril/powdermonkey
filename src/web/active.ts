import type { Session, Task } from "../server/schema.ts";

// Active-ness is DERIVED, not stored. A task is ACTIVE when it has a live
// (non-archived) session row — one is created by Start local AND by Dispatch
// remote, so both kinds of work show up the same way. There is no schema field
// for this: the store's `sessions` list already excludes archived rows (the CRUD
// list filters on archived_at), so the mere presence of a session for a task id
// is the whole signal. Both panes read active-ness from here so they can never
// disagree about which tasks are live.

/** The set of task ids that currently have a live session attached. */
export function activeTaskIds(sessions: Session[]): Set<number> {
  const ids = new Set<number>();
  for (const s of sessions) if (s.taskId != null) ids.add(s.taskId);
  return ids;
}

/** True when the task has a live session (i.e. it belongs in the Active pane). */
export function isActive(taskId: number, active: Set<number>): boolean {
  return active.has(taskId);
}

/** Split a list of tasks into the Active set (has a live session) and the Backlog
 *  (everything else — the to-be-worked launchpad). Order within each list is
 *  preserved, so callers can sort first and keep that order. */
export function partitionTasks(
  tasks: Task[],
  active: Set<number>,
): { active: Task[]; backlog: Task[] } {
  const inActive: Task[] = [];
  const inBacklog: Task[] = [];
  for (const t of tasks) (active.has(t.id) ? inActive : inBacklog).push(t);
  return { active: inActive, backlog: inBacklog };
}
