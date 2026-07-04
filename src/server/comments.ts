import { and, asc, eq, isNull } from "drizzle-orm";
import type { CommentAuthor } from "../shared/types.ts";
import { db } from "./db.ts";
import { type TaskComment, taskComments, tasks } from "./schema.ts";

// A task's diary: one-line comments on a task. Capture is zero-ceremony (append a
// line, auto-timestamped), and after that a line is an ordinary row — edit it in
// place (fix the typo), archive it (soft delete, like every other entity). Every
// mutation is scoped to the comment's task so a stray id can't cross diaries.

/** A task's live (non-archived) comments, oldest first — the diary reads
 *  top-to-bottom. Ties on the timestamp (same-instant inserts) fall back to
 *  insertion order via the id. */
export async function listComments(taskId: number): Promise<TaskComment[]> {
  return db
    .select()
    .from(taskComments)
    .where(and(eq(taskComments.taskId, taskId), isNull(taskComments.archivedAt)))
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

/** Edit one line's body in place (typo fix, better wording). `updated_at` records
 *  the edit. Returns the updated row, or null when the comment isn't on this task. */
export async function updateComment(
  taskId: number,
  commentId: number,
  body: string,
): Promise<TaskComment | null> {
  const [row] = await db
    .update(taskComments)
    .set({ body, updatedAt: new Date() })
    .where(and(eq(taskComments.id, commentId), eq(taskComments.taskId, taskId)))
    .returning();
  return row ?? null;
}

/** Archive one line — the same soft delete as every other entity (sets archived_at,
 *  drops out of the list). Returns the archived row, or null when it wasn't there. */
export async function archiveComment(
  taskId: number,
  commentId: number,
): Promise<TaskComment | null> {
  const [row] = await db
    .update(taskComments)
    .set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(taskComments.id, commentId), eq(taskComments.taskId, taskId)))
    .returning();
  return row ?? null;
}
