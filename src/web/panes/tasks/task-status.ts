import type { Task } from "../../../server/schema.ts";
import { TaskStatus } from "../../../shared/types.ts";

/** A finished / won't-do / archived task — it shows its outcome cluster (badge +
 *  reopen + links) in place of the launch actions, in both the card and row views. */
export function isTerminal(task: Task): boolean {
  return (
    task.status === TaskStatus.Merged ||
    task.status === TaskStatus.Cancelled ||
    task.archivedAt != null
  );
}
