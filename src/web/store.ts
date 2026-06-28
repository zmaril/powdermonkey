import type { SerializedDockview } from "dockview-react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Note } from "../server/schema.ts";
import { api } from "./client.ts";

// UI + action store. All *plan/session data* now lives in TanStack DB collections
// (collections.ts), synced live from PGlite — so this store no longer holds or
// refetches server data. What's left is transient UI state (dock layout, shell/notes
// requests, tab indicators, in-flight spinners) and the write actions. The actions
// just POST/PATCH to the REST routes; the resulting DB write streams back through
// /sync and updates the collections, so there's no `refresh()` to call.

export type StartInfo = {
  taskId: number;
  branch: string;
  worktreePath: string;
  prompt: string;
  trailers: string[];
};

type State = {
  // Operator toggle: whether the watcher auto-asks @claude to rebase conflicting PRs.
  // Server runtime state (not a synced table), loaded via loadSettings.
  autoRebase: boolean;
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
  // Latest request to open a browser pane (an iframe pointed at a dev server /
  // local preview). `url` is the page to load; `n` makes repeats distinct so App's
  // effect re-fires. App adds a `browser` panel keyed so a fresh one opens each time.
  browserReq: { url: string; n: number } | null;
  // The last URL loaded in a Browser pane, remembered across reloads (persisted) so a
  // fresh pane opens where you left off. Updated whenever a pane navigates.
  lastBrowserUrl: string;
  rememberBrowserUrl: (url: string) => void;
  // Latest request to open (or focus) a singleton pane — the plan views and the
  // single-instance tool panes (scratch, settings, about, help). App focuses it if
  // it's already open, else adds it to the active group. `n` makes repeats distinct
  // so the effect re-fires. (Shell and Browser are multi-instance, so they keep
  // their own request signals.)
  paneReq: { id: string; n: number } | null;
  openPane: (id: string) => void;
  // In-app activity indicators, keyed by dockview panel id (e.g. "active"). True
  // means the pane has changes you haven't seen because its tab wasn't on screen;
  // the tab shows an ambient dot until viewed. Transient — never persisted.
  tabActivity: Record<string, boolean>;
  flagTab: (paneId: string) => void;
  clearTab: (paneId: string) => void;
  // The PR currently under review, shown as a full-window takeover overlay (not a
  // dockview panel — review is a focused activity). null = no overlay.
  review: { number: number; title: string } | null;
  // The serialized dockview layout (api.toJSON()). Persisted so a reload — notably
  // the disconnect→refresh recovery — restores your panes; null means "lay out the
  // default". This is the single source of truth for the dock; layout-changing
  // buttons set it here and App reflects it onto the dockview api.
  layout: SerializedDockview | null;
  setLayout: (layout: SerializedDockview | null) => void;
  openTerminal: (cwd?: string) => void;
  openSessionTerminal: (sessionId: number, title: string) => void;
  openBrowser: (url?: string) => void;
  loadSettings: () => Promise<void>;
  openReview: (number: number, title: string) => void;
  closeReview: () => void;
  // The scratchpad is a single note. Returns it, creating the row on first use.
  ensureScratch: () => Promise<Note | null>;
  saveNote: (id: number, values: { title?: string; body?: string }) => Promise<void>;
  toggleStar: (taskId: number, starred: boolean) => Promise<void>;
  setAutoRebase: (on: boolean) => Promise<void>;
  startLocal: (taskId: number) => Promise<void>;
  dispatch: (taskId: number) => Promise<void>;
  // Launch several backlog tasks together: ONE session works the whole batch. The
  // first id is the primary (it names the worktree/branch); the rest ride along.
  startLocalMany: (taskIds: number[], comment?: string) => Promise<void>;
  dispatchMany: (taskIds: number[], comment?: string) => Promise<void>;
  teleport: (taskId: number) => Promise<void>;
  // Operator decisions (the non-reconciled path): mark a phase/task done by hand,
  // close a task as won't-do (cancel), or walk either back (reopen). The UI is the
  // operator, so these post with no `source` and the server stamps
  // `decision_source = operator`. The DB write streams back over /sync — nothing to
  // refresh.
  completePhase: (phaseId: number) => Promise<void>;
  reopenPhase: (phaseId: number) => Promise<void>;
  completeTask: (taskId: number) => Promise<void>;
  cancelTask: (taskId: number) => Promise<void>;
  reopenTask: (taskId: number) => Promise<void>;
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
// show a spinner immediately and clear it once the work settles.
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

// Single-flight: the scratchpad is exactly one note. The first caller that finds no
// note creates it; concurrent or StrictMode double-calls reuse the same promise so we
// never create two scratch rows. The created row streams into the notes collection.
let scratchInit: Promise<Note | null> | null = null;
function ensureScratch(setError: (e: string) => void): Promise<Note | null> {
  if (scratchInit) return scratchInit;
  scratchInit = (async () => {
    const { data, error } = await api.notes.get();
    if (error) {
      setError(String(error.value ?? error.status));
      scratchInit = null;
      return null;
    }
    const list = ((data ?? []) as Note[]).sort((a, b) => a.id - b.id);
    if (list.length > 0) return list[0];
    const created = await api.notes.post({ title: "scratch", body: "", position: 0 });
    if (created.error) {
      setError(String(created.error.value ?? created.error.status));
      scratchInit = null;
      return null;
    }
    return created.data as Note;
  })();
  return scratchInit;
}

export const useStore = create<State>()(
  persist(
    (set, get) => ({
      autoRebase: true,
      error: null,
      pending: {},
      lastStart: null,
      shellReq: null,
      browserReq: null,
      lastBrowserUrl: "http://localhost:3000",
      rememberBrowserUrl: (url) => set({ lastBrowserUrl: url }),
      paneReq: null,
      openPane: (id) => set((s) => ({ paneReq: { id, n: (s.paneReq?.n ?? 0) + 1 } })),
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
      review: null,
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
      openBrowser: (url) =>
        set((s) => ({
          browserReq: { url: url ?? s.lastBrowserUrl, n: (s.browserReq?.n ?? 0) + 1 },
        })),
      openReview: (number, title) => set({ review: { number, title } }),
      closeReview: () => set({ review: null }),
      loadSettings: async () => {
        const { data, error } = await api.settings.get();
        if (error) return;
        set({ autoRebase: (data as { autoRebase?: boolean } | null)?.autoRebase ?? true });
      },
      ensureScratch: () => ensureScratch((e) => set({ error: e })),
      saveNote: async (id, values) => {
        // The local draft (in ScratchPad) keeps typing responsive; persist via PATCH
        // and the notes collection reflects the saved value when the delta streams back.
        const { error } = await api.notes({ id }).patch(values);
        if (error) set({ error: String(error.value ?? error.status) });
      },
      toggleStar: async (taskId, starred) => {
        // No optimism: the PATCH writes the row, the tasks collection re-sorts the
        // pane when the delta arrives over /sync.
        const { error } = await api.tasks({ id: taskId }).patch({ starred });
        if (error) set({ error: String(error.value ?? error.status) });
      },
      setAutoRebase: async (on) => {
        set({ autoRebase: on }); // optimistic — this is store state, not a synced table
        const { error } = await api.settings.post({ autoRebase: on });
        if (error) {
          set({ error: String(error.value ?? error.status) });
          await get().loadSettings(); // revert to server truth on failure
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
        }),
      dispatch: (taskId) =>
        withPending(set, `dispatch:${taskId}`, async () => {
          const { error } = await api.tasks({ id: taskId }).dispatch.post();
          if (error) set({ error: errMsg(error) });
        }),
      startLocalMany: async (taskIds, comment) => {
        if (taskIds.length === 0) return;
        const [primary, ...rest] = taskIds;
        const { data, error } = await api
          .tasks({ id: primary })
          ["start-local"].post({ taskIds: rest, comment });
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
      },
      dispatchMany: async (taskIds, comment) => {
        if (taskIds.length === 0) return;
        const [primary, ...rest] = taskIds;
        const { error } = await api
          .tasks({ id: primary })
          .dispatch.post({ taskIds: rest, comment });
        if (error) set({ error: errMsg(error) });
      },
      teleport: (taskId) =>
        withPending(set, `teleport:${taskId}`, async () => {
          const { data, error } = await api.tasks({ id: taskId }).teleport.post();
          if (error) return void set({ error: errMsg(error) });
          if (data && "ok" in data && !data.ok) set({ error: data.error });
        }),
      completePhase: async (phaseId) => {
        const { error } = await api.phases({ id: phaseId }).complete.post();
        if (error) set({ error: String(error.value ?? error.status) });
      },
      reopenPhase: async (phaseId) => {
        const { error } = await api.phases({ id: phaseId }).reopen.post();
        if (error) set({ error: String(error.value ?? error.status) });
      },
      completeTask: async (taskId) => {
        const { error } = await api.tasks({ id: taskId }).complete.post();
        if (error) set({ error: String(error.value ?? error.status) });
      },
      cancelTask: async (taskId) => {
        const { error } = await api.tasks({ id: taskId }).cancel.post();
        if (error) set({ error: String(error.value ?? error.status) });
      },
      reopenTask: async (taskId) => {
        const { error } = await api.tasks({ id: taskId }).reopen.post();
        if (error) set({ error: String(error.value ?? error.status) });
      },
      land: async (sessionId) => {
        const { error } = await api.sessions({ id: sessionId }).land.post();
        if (error) set({ error: String(error.value ?? error.status) });
      },
      stop: async (sessionId) => {
        const { error } = await api.sessions({ id: sessionId }).stop.post();
        if (error) set({ error: String(error.value ?? error.status) });
      },
      openEditor: async (sessionId) => {
        const { data, error } = await api.sessions({ id: sessionId })["open-editor"].post();
        if (error) return void set({ error: String(error.value ?? error.status) });
        if (data && "ok" in data && !data.ok) set({ error: data.error });
      },
      reconcile: async () => {
        const { error } = await api.reconcile.post();
        if (error) set({ error: String(error.value ?? error.status) });
      },
      dismissStart: () => set({ lastStart: null }),
      setError: (error) => set({ error }),
    }),
    {
      // Persist only the dock layout — collections re-sync, and actions / transient
      // request signals must never be rehydrated from storage.
      name: "pm-ui",
      // Persist the dock layout and the auto-rebase toggle so they rehydrate
      // synchronously on load — the toggle renders in its last position instead of
      // flipping from the default once the server value arrives.
      partialize: (s) => ({
        layout: s.layout,
        autoRebase: s.autoRebase,
        lastBrowserUrl: s.lastBrowserUrl,
      }),
    },
  ),
);
