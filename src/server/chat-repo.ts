// Persistence for the chat surface: threads (sidebar "Recents") and their
// messages. Plain CRUD — these aren't domain entities, so they skip the
// action-log/diff machinery. Thread id is client-supplied and idempotent, so
// the assistant-ui client id, the server row id, and the adapter remoteId all
// coincide (no id mapping needed).

import { desc, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "./db.ts";
import { chatMessages, chatThreads, goals, tasks, workspaces, workstreams } from "./schema.ts";

const newId = () => `thr-${crypto.randomUUID().slice(0, 8)}`;

// A fresh thread is workspace-less (a loose assistant chat). It gains a workspace
// when bound to a supervisor (via the picker) or created as a worker chat.
export async function ensureThread(id?: string) {
  const tid = id ?? newId();
  await db().insert(chatThreads).values({ id: tid }).onConflictDoNothing();
  const [row] = await db().select().from(chatThreads).where(eq(chatThreads.id, tid));
  return row;
}

export function listThreads() {
  return db()
    .select()
    .from(chatThreads)
    .where(isNotNull(chatThreads.title))
    .orderBy(desc(chatThreads.updatedAt));
}

export async function getThread(id: string) {
  const [row] = await db().select().from(chatThreads).where(eq(chatThreads.id, id));
  return row ?? null;
}

export async function renameThread(id: string, title: string) {
  await db()
    .update(chatThreads)
    .set({ title, updatedAt: new Date() })
    .where(eq(chatThreads.id, id));
}

export async function setArchived(id: string, archived: boolean) {
  await db()
    .update(chatThreads)
    .set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
    .where(eq(chatThreads.id, id));
}

export async function archiveThread(id: string) {
  await db()
    .update(chatThreads)
    .set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(eq(chatThreads.id, id));
}

export async function setThreadSession(id: string, claudeSessionId: string) {
  await db()
    .update(chatThreads)
    .set({ claudeSessionId, updatedAt: new Date() })
    .where(eq(chatThreads.id, id));
}

export async function getMessages(threadId: string) {
  const rows = await db()
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.threadId, threadId))
    .orderBy(chatMessages.seq);
  return rows.map((r) => r.message);
}

function extractUserText(message: any): string | null {
  if (message?.role !== "user") return null;
  const parts = Array.isArray(message.content) ? message.content : [];
  const text = parts
    .filter((p: any) => p?.type === "text")
    .map((p: any) => p.text)
    .join(" ")
    .trim();
  return text || null;
}

export async function appendMessage(threadId: string, message: any) {
  await ensureThread(threadId);
  const [last] = await db()
    .select({ s: chatMessages.seq })
    .from(chatMessages)
    .where(eq(chatMessages.threadId, threadId))
    .orderBy(desc(chatMessages.seq))
    .limit(1);
  const seq = (last?.s ?? 0) + 1;
  await db()
    .insert(chatMessages)
    .values({ id: `msg-${crypto.randomUUID().slice(0, 8)}`, threadId, seq, message });

  const thread = await getThread(threadId);
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (thread && thread.kind === "assistant" && !thread.title) {
    const text = extractUserText(message);
    if (text) patch.title = text.slice(0, 60);
  }
  await db().update(chatThreads).set(patch).where(eq(chatThreads.id, threadId));
}

// ---- supervisor-chat binding + context ----
export interface ThreadBind {
  kind: "supervisor";
  goalId?: string;
  workspaceId?: string;
  title?: string;
}

export async function bindThread(id: string, bind: ThreadBind) {
  const patch: Record<string, unknown> = { kind: bind.kind, updatedAt: new Date() };
  if (bind.goalId) patch.goalId = bind.goalId;
  if (bind.workspaceId) patch.workspaceId = bind.workspaceId;
  if (bind.title) patch.title = bind.title;
  await db().update(chatThreads).set(patch).where(eq(chatThreads.id, id));
}

export async function getGoalContext(goalId: string) {
  const [goal] = await db().select().from(goals).where(eq(goals.id, goalId));
  if (!goal) return null;
  const [workspace] = await db()
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, goal.workspaceId));
  const ws = await db().select().from(workstreams).where(eq(workstreams.goalId, goalId));
  const wsIds = ws.map((w) => w.id);
  const taskRows = wsIds.length
    ? await db().select().from(tasks).where(inArray(tasks.workstreamId, wsIds))
    : [];
  return { goal, workspace: workspace ?? null, tasks: taskRows };
}

export async function getWorkspaceContext(workspaceId: string) {
  const [workspace] = await db().select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!workspace) return null;
  const goalRows = await db().select().from(goals).where(eq(goals.workspaceId, workspaceId));
  return { workspace, goals: goalRows };
}

// Set (or clear) a thread's workspace. Choosing a workspace makes it a supervisor
// chat grounded in that workspace; clearing returns it to a loose assistant chat.
export async function setWorkspace(id: string, workspaceId: string | null) {
  await db()
    .update(chatThreads)
    .set({
      workspaceId,
      kind: workspaceId ? "supervisor" : "assistant",
      updatedAt: new Date(),
    })
    .where(eq(chatThreads.id, id));
}
