import type { CloudPr } from "../../../server/events.ts";
import type { Session, Task } from "../../../server/schema.ts";
import type { Indexes } from "../../plan-data.ts";

// Shared helpers + types for the Active pane: the unit here is the WORKER (a live
// session), not the task — one session can be dispatched for several tasks (the
// session_tasks join), so the views group tasks by the session they share.

export type View = "flat" | "grouped";

export type SessionGrouping = { session: Session; tasks: Task[] };

/** Group active tasks by the live session they share, preserving input order (so a
 *  star-first list stays star-first). Every active task has a session — the active
 *  set is derived from sessions — but a task whose session somehow doesn't resolve
 *  is skipped rather than rendered sessionless. */
export function groupBySession(tasks: Task[], idx: Indexes): SessionGrouping[] {
  const groups = new Map<number, SessionGrouping>();
  const order: number[] = [];
  for (const t of tasks) {
    const session = idx.sessionByTask.get(t.id);
    if (!session) continue;
    let g = groups.get(session.id);
    if (!g) {
      g = { session, tasks: [] };
      groups.set(session.id, g);
      order.push(session.id);
    }
    g.tasks.push(t);
  }
  return order.map((id) => groups.get(id) as SessionGrouping);
}

/** The goal › milestone trail a task hangs under. */
export function contextOf(task: Task, idx: Indexes): string {
  const m = idx.milestoneById.get(task.milestoneId);
  const g = m ? idx.goalById.get(m.goalId) : undefined;
  return [g?.title, m?.title].filter(Boolean).join(" › ");
}

/** The PRs a worker's tasks have opened, de-duped by PR number (a multi-task worker
 *  can land one PR for several tasks). */
export function workerPrs(tasks: Task[], idx: Indexes): CloudPr[] {
  const out: CloudPr[] = [];
  const seen = new Set<number>();
  for (const t of tasks) {
    const pr = idx.prByTask.get(t.id);
    if (pr && !seen.has(pr.number)) {
      seen.add(pr.number);
      out.push(pr);
    }
  }
  return out;
}
