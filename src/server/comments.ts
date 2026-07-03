import { and, asc, eq } from "drizzle-orm";
import type { CommentAuthor } from "../shared/types.ts";
import { db } from "./db.ts";
import { type TaskComment, taskComments, tasks } from "./schema.ts";

// A task's diary: append, read, and delete-a-line — deliberately NO update. A
// comment is a timestamped one-liner muttered onto a task; once spoken it can be
// taken back (deleted outright) but never rewritten. The API surface here is the
// enforcement seam: no function edits a row, and the table itself carries no
// updated_at to edit with (see schema.ts).

/** A task's comments, oldest first — the diary reads top-to-bottom. Ties on the
 *  timestamp (same-instant inserts) fall back to insertion order via the id. */
export async function listComments(taskId: number): Promise<TaskComment[]> {
  return db
    .select()
    .from(taskComments)
    .where(eq(taskComments.taskId, taskId))
    .orderBy(asc(taskComments.createdAt), asc(taskComments.id));
}

/** Append one line to a task's diary, auto-timestamped by the DB. Returns null when
 *  the task doesn't exist (the FK would refuse anyway; this keeps it a clean 404).
 *  `author` records who spoke — operator (default) or supervisor. */
export async function appendComment(
  taskId: number,
  body: string,
  author?: CommentAuthor,
): Promise<TaskComment | null> {
  const [task] = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskId));
  if (!task) return null;
  const [row] = await db
    .insert(taskComments)
    .values(author ? { taskId, body, author } : { taskId, body })
    .returning();
  return row;
}

/** Delete one line from a task's diary — a hard DELETE, not an archive (the table
 *  has no archived_at). Scoped to the task so a stray id can't cross diaries.
 *  Returns the removed row, or null when it wasn't there. */
export async function deleteComment(
  taskId: number,
  commentId: number,
): Promise<TaskComment | null> {
  const [row] = await db
    .delete(taskComments)
    .where(and(eq(taskComments.id, commentId), eq(taskComments.taskId, taskId)))
    .returning();
  return row ?? null;
}
