import type { SerializedDockview } from "dockview-react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { CloudPr } from "../server/events.ts";
import type { Goal, Milestone, Note, Phase, Session, Task } from "../server/schema.ts";
import type { SessionLink } from "./active.ts";
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
  // The session↔task join (many tasks per session). Both panes intersect these
  // with `sessions` to derive which tasks are active and which session each shows.
  sessionTasks: SessionLink[];
  notes: Note[];
  // Live PR status per task-linked PR (CI / mergeable / draft), served fresh from
  // the github-watch loop — runtime data the Active panel reads, not persisted.
  cloudPrs: CloudPr[];
  // The book of work: archived + finished rows (fetched with ?archived=true, which
  // returns live AND archived). The Archive pane reads this; the live panes don't.
  archive: {
    goals: Goal[];
    milestones: Milestone[];
    tasks: Task[];
    phases: Phase[];
    sessions: Session[];
    sessionTasks: SessionLink[];
  };
  loading: boolean;
  error: string | null;
  // In-flight slow actions, keyed `${action}:${taskId}` (e.g. `dispatch:7`). A button
  // reads its own key to show a spinner the instant it's clicked — dispatch/start-local
  // spawn a PTY and take seconds before the task flips to active, so without this the
  // operator gets no feedback. Never persisted; cleared in a finally so it can't stick.
  pending: Record<string, boolean>;
  lastStart: StartInfo | null;
  // Latest request to open a shell panel. `session` attaches to a local session's
  // agent PTY; otherwise `cwd` opens a fresh shell ("" = repo dir). `key` dedupes
  // panels, `title` labels them, `n` makes repeats distinct so the effect re-fires.
  shellReq: { key: string; cwd: string; session: number | null; title: string; n: number } | null;
  // Bumped each time the operator asks to open the notepad; App watches it.
  notesReq: number;
  // In-app activity indicators, keyed by dockview panel id (e.g. "active"). True
  // means the pane has changes you haven't seen because its tab wasn't on screen;
  // the tab shows an ambient dot until viewed. Transient — never persisted.
  tabActivity: Record<string, boolean>;
  flagTab: (paneId: string) => void;
  clearTab: (paneId: string) => void;
  // The serialized dockview layout (api.toJSON()). Persisted so a reload — notably
  // the disconnect→refresh recovery — restores your panes; null means "lay out the
  // default". This is the single source of truth for the dock; layout-changing
  // buttons set it here and App reflects it onto the dockview api.
  layout: SerializedDockview | null;
  setLayout: (layout: SerializedDockview | null) => void;
  openTerminal: (cwd?: string) => void;
  openSessionTerminal: (sessionId: number, title: string) => void;
  openNotes: () => void;
  refresh: () => Promise<void>;
  refreshArchive: () => Promise<void>;
  refreshNotes: () => Promise<void>;
  // The scratchpad is a single note. Returns it, creating the row on first use.
  ensureScratch: () => Promise<Note | null>;
  saveNote: (id: number, values: { title?: string; body?: string }) => Promise<void>;
  toggleStar: (taskId: number, starred: boolean) => Promise<void>;
  startLocal: (taskId: number) => Promise<void>;
  dispatch: (taskId: number) => Promise<void>;
  // Launch several backlog tasks together: ONE session works the whole batch. The
  // first id is the primary (it names the worktree/branch); the rest ride along.
  startLocalMany: (taskIds: number[]) => Promise<void>;
  dispatchMany: (taskIds: number[]) => Promise<void>;
  teleport: (taskId: number) => Promise<void>;
  land: (sessionId: number) => Promise<void>;
  stop: (sessionId: number) => Promise<void>;
  openEditor: (sessionId: number) => Promise<void>;
  reconcile: () => Promise<void>;
  dismissStart: () => void;
  setError: (error: string | null) => void;
};

// A failing runtime route (dispatch/start-local/teleport) replies 400 with a JSON
// body `{ ok: false, error }`, which Eden surfaces as `error.value`. Pull the human
// message out of that body so the banner shows the reason instead of "[object Object]".
function errMsg(error: { value?: unknown; status?: number }): string {
  const v = error.value;
  if (v && typeof v === "object" && "error" in v) return String((v as { error: unknown }).error);
  return String(v ?? error.status);
}

// Run an action while flagging its `pending` key, so the button that triggered it can
// show a spinner immediately and clear it once the work (including the refresh) settles.
async function withPending(
  set: (fn: (s: State) => Partial<State>) => void,
  key: string,
  fn: () => Promise<void>,
): Promise<void> {
  set((s) => ({ pending: { ...s.pending, [key]: true } }));
  try {
    await fn();
  } finally {
    set((s) => {
      const { [key]: _drop, ...rest } = s.pending;
      return { pending: rest };
    });
  }
}

// Single-flight: the scratchpad is exactly one note. The first caller that finds
// no note creates it; concurrent or StrictMode double-calls reuse the same promise
// so we never create two scratch rows.
let scratchInit: Promise<Note | null> | null = null;
function ensureScratch(set: (partial: Partial<State>) => void): Promise<Note | null> {
  if (scratchInit) return scratchInit;
  scratchInit = (async () => {
    const { data, error } = await api.notes.get();
    if (error) {
      set({ error: String(error.value ?? error.status) });
      scratchInit = null;
      return null;
    }
    const list = ((data ?? []) as Note[]).sort((a, b) => a.id - b.id);
    if (list.length > 0) {
      set({ notes: list });
      return list[0];
    }
    const created = await api.notes.post({ title: "scratch", body: "", position: 0 });
    if (created.error) {
      set({ error: String(created.error.value ?? created.error.status) });
      scratchInit = null;
      return null;
    }
    const note = created.data as Note;
    set({ notes: [note] });
    return note;
  })();
  return scratchInit;
}

export const useStore = create<State>()(
  persist(
    (set, get) => ({
      goals: [],
      milestones: [],
      tasks: [],
      phases: [],
      sessions: [],
      sessionTasks: [],
      notes: [],
      cloudPrs: [],
      archive: { goals: [], milestones: [], tasks: [], phases: [], sessions: [], sessionTasks: [] },
      loading: false,
      error: null,
      pending: {},
      lastStart: null,
      shellReq: null,
      notesReq: 0,
      tabActivity: {},
      flagTab: (paneId) =>
        set((s) =>
          s.tabActivity[paneId] ? {} : { tabActivity: { ...s.tabActivity, [paneId]: true } },
        ),
      clearTab: (paneId) =>
        set((s) => {
          if (!s.tabActivity[paneId]) return {};
          const { [paneId]: _drop, ...rest } = s.tabActivity;
          return { tabActivity: rest };
        }),
      layout: null,
      setLayout: (layout) => set({ layout }),
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
      openNotes: () => set((s) => ({ notesReq: s.notesReq + 1 })),
      refreshNotes: async () => {
        const { data, error } = await api.notes.get();
        if (error) return void set({ error: String(error.value ?? error.status) });
        set({ notes: (data ?? []) as Note[] });
      },
      ensureScratch: () => ensureScratch(set),
      saveNote: async (id, values) => {
        // Optimistic: reflect the edit locally so typing stays responsive, then PATCH.
        set((s) => ({ notes: s.notes.map((n) => (n.id === id ? { ...n, ...values } : n)) }));
        const { error } = await api.notes({ id }).patch(values);
        if (error) set({ error: String(error.value ?? error.status) });
      },
      refresh: async () => {
        set({ loading: true, error: null });
        try {
          const [goals, milestones, tasks, phases, sessions, sessionTasks, notes, cloudPrs] =
            await Promise.all([
              api.goals.get(),
              api.milestones.get(),
              api.tasks.get(),
              api.phases.get(),
              api.sessions.get(),
              api["session-tasks"].get(),
              api.notes.get(),
              api["cloud-prs"].get(),
            ]);
          const err =
            goals.error ??
            milestones.error ??
            tasks.error ??
            phases.error ??
            sessions.error ??
            sessionTasks.error ??
            notes.error;
          if (err) throw new Error(String(err.value ?? err.status));
          set({
            goals: (goals.data ?? []) as Goal[],
            milestones: (milestones.data ?? []) as Milestone[],
            tasks: (tasks.data ?? []) as Task[],
            phases: (phases.data ?? []) as Phase[],
            sessions: (sessions.data ?? []) as Session[],
            sessionTasks: (sessionTasks.data ?? []) as SessionLink[],
            notes: (notes.data ?? []) as Note[],
            // Non-fatal if it fails (watcher disabled / GitHub blip): keep status empty.
            cloudPrs: (cloudPrs.data ?? []) as CloudPr[],
            loading: false,
          });
        } catch (e) {
          set({ error: e instanceof Error ? e.message : String(e), loading: false });
        }
      },
      refreshArchive: async () => {
        // ?archived=true returns live AND archived rows; the pane filters to the
        // finished/archived set. We pull the full hierarchy so a task whose goal or
        // milestone was archived still resolves its context.
        const q = { query: { archived: "true" } };
        const [goals, milestones, tasks, phases, sessions, sessionTasks] = await Promise.all([
          api.goals.get(q),
          api.milestones.get(q),
          api.tasks.get(q),
          api.phases.get(q),
          api.sessions.get(q),
          api["session-tasks"].get(),
        ]);
        const err =
          goals.error ??
          milestones.error ??
          tasks.error ??
          phases.error ??
          sessions.error ??
          sessionTasks.error;
        if (err) return void set({ error: String(err.value ?? err.status) });
        set({
          archive: {
            goals: (goals.data ?? []) as Goal[],
            milestones: (milestones.data ?? []) as Milestone[],
            tasks: (tasks.data ?? []) as Task[],
            phases: (phases.data ?? []) as Phase[],
            sessions: (sessions.data ?? []) as Session[],
            sessionTasks: (sessionTasks.data ?? []) as SessionLink[],
          },
        });
      },
      toggleStar: async (taskId, starred) => {
        // Optimistic: flip it locally so the row re-sorts instantly, then PATCH. The
        // panes derive their order off store.tasks, so this re-sorts on the spot.
        set((s) => ({ tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, starred } : t)) }));
        const { error } = await api.tasks({ id: taskId }).patch({ starred });
        if (error) {
          set({ error: String(error.value ?? error.status) });
          await get().refresh(); // revert to server truth on failure
        }
      },
      startLocal: (taskId) =>
        withPending(set, `start-local:${taskId}`, async () => {
          const { data, error } = await api.tasks({ id: taskId })["start-local"].post();
          if (error) return void set({ error: errMsg(error) });
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
        }),
      dispatch: (taskId) =>
        withPending(set, `dispatch:${taskId}`, async () => {
          const { error } = await api.tasks({ id: taskId }).dispatch.post();
          // Bail before refresh() on failure — refresh clears `error`, which is what
          // used to swallow dispatch failures (the PTY can exit non-zero, so the route
          // replies ok:false) and leave the button looking like it did nothing.
          if (error) return void set({ error: errMsg(error) });
          await get().refresh();
        }),
      startLocalMany: async (taskIds) => {
        if (taskIds.length === 0) return;
        const [primary, ...rest] = taskIds;
        const { data, error } = await api
          .tasks({ id: primary })
          ["start-local"].post({ taskIds: rest });
        if (error) return void set({ error: errMsg(error) });
        if (data && "ok" in data && data.ok) {
          set({
            lastStart: {
              taskId: primary,
              branch: data.branch,
              worktreePath: data.worktreePath,
              prompt: data.prompt,
              trailers: data.trailers,
            },
          });
        }
        await get().refresh();
      },
      dispatchMany: async (taskIds) => {
        if (taskIds.length === 0) return;
        const [primary, ...rest] = taskIds;
        const { error } = await api.tasks({ id: primary }).dispatch.post({ taskIds: rest });
        // Same as single dispatch: bail before refresh() so a batch failure surfaces.
        if (error) return void set({ error: errMsg(error) });
        await get().refresh();
      },
      teleport: (taskId) =>
        withPending(set, `teleport:${taskId}`, async () => {
          const { data, error } = await api.tasks({ id: taskId }).teleport.post();
          if (error) return void set({ error: errMsg(error) });
          if (data && "ok" in data && !data.ok) return void set({ error: data.error });
          await get().refresh();
        }),
      land: async (sessionId) => {
        const { error } = await api.sessions({ id: sessionId }).land.post();
        if (error) set({ error: String(error.value ?? error.status) });
        await get().refresh();
      },
      stop: async (sessionId) => {
        const { error } = await api.sessions({ id: sessionId }).stop.post();
        if (error) set({ error: String(error.value ?? error.status) });
        await get().refresh();
      },
      openEditor: async (sessionId) => {
        const { data, error } = await api.sessions({ id: sessionId })["open-editor"].post();
        if (error) return void set({ error: String(error.value ?? error.status) });
        if (data && "ok" in data && !data.ok) set({ error: data.error });
      },
      reconcile: async () => {
        const { error } = await api.reconcile.post();
        if (error) set({ error: String(error.value ?? error.status) });
        await get().refresh();
      },
      dismissStart: () => set({ lastStart: null }),
      setError: (error) => set({ error }),
    }),
    {
      // Persist only the dock layout — server data is refetched, and actions /
      // transient request signals must never be rehydrated from storage.
      name: "pm-ui",
      partialize: (s) => ({ layout: s.layout }),
    },
  ),
);
