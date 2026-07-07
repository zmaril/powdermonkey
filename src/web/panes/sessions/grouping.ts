import type { CloudPr } from "../../../server/events.ts";
import type { Task } from "../../../server/schema.ts";
import type { Indexes } from "../../plan-data.ts";

// Shared helpers for the session (worker) card: the unit is the SESSION, not the task
// — one session can be dispatched for several tasks (the session_tasks join), so a card
// carries the goal › milestone context of each task and the de-duped PRs across them.

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
