// The TUI's thin HTTP client against the supervisor API — the same Elysia routes
// the browser uses. The TUI is a separate process (spawned per SSH connection, or
// run locally via `powdermonkey tui`), so it talks over HTTP rather than reaching
// into the DB. Type-only imports of the row shapes keep it decoupled from the
// server runtime (no PGlite, no Drizzle connection) while staying typed.

import type { Note, Session, SessionTask, Task } from "../server/schema.ts";

// Where the supervisor lives. Spawned shells inherit PM_URL (index.ts sets it after
// it binds a port); a local `powdermonkey tui` falls back to the default dev port.
export const PM_URL = process.env.PM_URL ?? "http://localhost:4500";

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${PM_URL}${path}`, { signal, headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return (await res.json()) as T;
}

// The plan tree comes back already formatted as markdown (headings + a phase
// checklist) — the same surface the web Plan pane round-trips. The TUI renders it
// almost verbatim, so one server-side formatter serves both front-ends.
export async function getPlanMarkdown(signal?: AbortSignal): Promise<string> {
  const res = await fetch(`${PM_URL}/plan/markdown`, { signal });
  if (!res.ok) throw new Error(`GET /plan/markdown → ${res.status}`);
  return await res.text();
}

export const getSessions = (signal?: AbortSignal) => get<Session[]>("/sessions", signal);
export const getSessionTasks = (signal?: AbortSignal) =>
  get<SessionTask[]>("/session-tasks", signal);
export const getTasks = (signal?: AbortSignal) => get<Task[]>("/tasks", signal);
export const getNotes = (signal?: AbortSignal) => get<Note[]>("/notes", signal);

export async function reconcile(): Promise<{ phasesMarked: number; tasksCompleted: number }> {
  const res = await fetch(`${PM_URL}/reconcile`, { method: "POST" });
  if (!res.ok) throw new Error(`POST /reconcile → ${res.status}`);
  return (await res.json()) as { phasesMarked: number; tasksCompleted: number };
}

// One round-trip for everything the dashboard renders. Fetched together so a poll
// tick is a single coherent snapshot; the caller maps it through model.ts.
export type Snapshot = {
  planMarkdown: string;
  sessions: Session[];
  sessionTasks: SessionTask[];
  tasks: Task[];
  notes: Note[];
};

export async function fetchSnapshot(signal?: AbortSignal): Promise<Snapshot> {
  const [planMarkdown, sessions, sessionTasks, tasks, notes] = await Promise.all([
    getPlanMarkdown(signal),
    getSessions(signal),
    getSessionTasks(signal),
    getTasks(signal),
    getNotes(signal),
  ]);
  return { planMarkdown, sessions, sessionTasks, tasks, notes };
}
