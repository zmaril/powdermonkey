import { create } from "zustand";
import type { Goal, Milestone, Phase, Session, Task } from "../server/schema.ts";
import { api } from "./client.ts";

export type StartInfo = {
  taskId: number;
  branch: string;
  worktreePath: string;
  prompt: string;
  trailers: string[];
};

type State = {
  goals: Goal[];
  milestones: Milestone[];
  tasks: Task[];
  phases: Phase[];
  sessions: Session[];
  loading: boolean;
  error: string | null;
  lastStart: StartInfo | null;
  // Latest request to open a shell panel. `session` attaches to a local session's
  // agent PTY; otherwise `cwd` opens a fresh shell ("" = repo dir). `key` dedupes
  // panels, `title` labels them, `n` makes repeats distinct so the effect re-fires.
  shellReq: { key: string; cwd: string; session: number | null; title: string; n: number } | null;
  openTerminal: (cwd?: string) => void;
  openSessionTerminal: (sessionId: number, title: string) => void;
  refresh: () => Promise<void>;
  startLocal: (taskId: number) => Promise<void>;
  dispatch: (taskId: number) => Promise<void>;
  land: (sessionId: number) => Promise<void>;
  openEditor: (sessionId: number) => Promise<void>;
  reconcile: () => Promise<void>;
  dismissStart: () => void;
};

export const useStore = create<State>((set, get) => ({
  goals: [],
  milestones: [],
  tasks: [],
  phases: [],
  sessions: [],
  loading: false,
  error: null,
  lastStart: null,
  shellReq: null,
  openTerminal: (cwd = "") =>
    set((s) => ({
      shellReq: {
        key: cwd ? `cwd:${cwd}` : "repo",
        cwd,
        session: null,
        title: cwd ? cwd.split("/").filter(Boolean).pop() || "shell" : "repo",
        n: (s.shellReq?.n ?? 0) + 1,
      },
    })),
  openSessionTerminal: (sessionId, title) =>
    set((s) => ({
      shellReq: {
        key: `session:${sessionId}`,
        cwd: "",
        session: sessionId,
        title,
        n: (s.shellReq?.n ?? 0) + 1,
      },
    })),
  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const [goals, milestones, tasks, phases, sessions] = await Promise.all([
        api.goals.get(),
        api.milestones.get(),
        api.tasks.get(),
        api.phases.get(),
        api.sessions.get(),
      ]);
      const err = goals.error ?? milestones.error ?? tasks.error ?? phases.error ?? sessions.error;
      if (err) throw new Error(String(err.value ?? err.status));
      set({
        goals: (goals.data ?? []) as Goal[],
        milestones: (milestones.data ?? []) as Milestone[],
        tasks: (tasks.data ?? []) as Task[],
        phases: (phases.data ?? []) as Phase[],
        sessions: (sessions.data ?? []) as Session[],
        loading: false,
      });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e), loading: false });
    }
  },
  startLocal: async (taskId) => {
    const { data, error } = await api.tasks({ id: taskId })["start-local"].post();
    if (error) return set({ error: String(error.value ?? error.status) });
    if (data && "ok" in data && data.ok) {
      set({
        lastStart: {
          taskId,
          branch: data.branch,
          worktreePath: data.worktreePath,
          prompt: data.prompt,
          trailers: data.trailers,
        },
      });
    }
    await get().refresh();
  },
  dispatch: async (taskId) => {
    const { error } = await api.tasks({ id: taskId }).dispatch.post();
    if (error) set({ error: String(error.value ?? error.status) });
    await get().refresh();
  },
  land: async (sessionId) => {
    const { error } = await api.sessions({ id: sessionId }).land.post();
    if (error) set({ error: String(error.value ?? error.status) });
    await get().refresh();
  },
  openEditor: async (sessionId) => {
    const { data, error } = await api.sessions({ id: sessionId })["open-editor"].post();
    if (error) return set({ error: String(error.value ?? error.status) });
    if (data && "ok" in data && !data.ok) set({ error: data.error });
  },
  reconcile: async () => {
    const { error } = await api.reconcile.post();
    if (error) set({ error: String(error.value ?? error.status) });
    await get().refresh();
  },
  dismissStart: () => set({ lastStart: null }),
}));
