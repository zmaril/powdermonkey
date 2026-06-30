import { partition } from "es-toolkit";
import type { Session, Task } from "../server/schema.ts";

// A session<->task link as the client consumes it (the /session-tasks endpoint
// returns just these two fields).
export type SessionLink = { sessionId: number; taskId: number };

// Active-ness is DERIVED, not stored. A task is ACTIVE when a live (non-archived)
// session is linked to it — sessions are created by Start local AND Dispatch
// remote, so both kinds of work show up the same way, and one session can be
// linked to several tasks at once (the session_tasks join). There is no schema
// field for this: the store's `sessions` list already excludes archived rows (the
// CRUD list filters on archived_at), so a link counts only when its session is
// still in that live list. Both panes read active-ness from here so they can never
// disagree about which tasks are live.

/** The set of task ids that currently have a live session linked to them. A link
 *  whose session isn't in `sessions` (archived, or another slice) is ignored, so
 *  the same link list serves both the live panes and the archive view. */
export function activeTaskIds(sessions: Session[], links: SessionLink[]): Set<number> {
  const live = new Set(sessions.map((s) => s.id));
  const ids = new Set<number>();
  for (const l of links) if (live.has(l.sessionId)) ids.add(l.taskId);
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
  const [inActive, backlog] = partition(tasks, (t) => active.has(t.id));
  return { active: inActive, backlog };
}
