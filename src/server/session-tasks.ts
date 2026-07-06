import { eq, inArray } from "drizzle-orm";
import { TaskStatus } from "../shared/types.ts";
import { db } from "./db.ts";
import { type Session, sessions, sessionTasks, tasks } from "./schema.ts";

// Helpers over the session_tasks join — the many-to-many link between a session
// and the tasks it's working. A session is created with a set of task ids
// (dispatch / start-local / start-exe / teleport), and each task reads back the
// shared session through these links.

/** Link a session to one or more tasks. A no-op for an empty list. */
export async function linkSessionTasks(sessionId: number, taskIds: number[]): Promise<void> {
  if (taskIds.length === 0) return;
  await db.insert(sessionTasks).values(taskIds.map((taskId) => ({ sessionId, taskId })));
}

/** The shared tail of every launch path: ONE session row for the whole batch,
 *  linked to every task, with each task marked dispatched (plus any extra task
 *  fields the launcher records, e.g. dispatch's session URL) so the batch moves
 *  to Active together. */
export async function createSessionForTasks(
  values: typeof sessions.$inferInsert,
  taskIds: number[],
  taskFields: Partial<typeof tasks.$inferInsert> = {},
): Promise<Session> {
  const [session] = await db.insert(sessions).values(values).returning();
  await linkSessionTasks(session.id, taskIds);
  await db
    .update(tasks)
    .set({ status: TaskStatus.Dispatched, ...taskFields, updatedAt: new Date() })
    .where(inArray(tasks.id, taskIds));
  return session;
}

/** The task ids a session is working, in link-insertion (so primary-first) order. */
export async function taskIdsForSession(sessionId: number): Promise<number[]> {
  const rows = await db
    .select({ taskId: sessionTasks.taskId })
    .from(sessionTasks)
    .where(eq(sessionTasks.sessionId, sessionId))
    .orderBy(sessionTasks.id);
  return rows.map((r) => r.taskId);
}

/** Every session<->task link (both kinds, live and archived sessions). The client
 *  resolves liveness itself by intersecting with the sessions it holds, so this
 *  serves both the live panes and the archive view from one list. */
export async function listSessionTasks(): Promise<{ sessionId: number; taskId: number }[]> {
  return db
    .select({ sessionId: sessionTasks.sessionId, taskId: sessionTasks.taskId })
    .from(sessionTasks)
    .orderBy(sessionTasks.id);
}
