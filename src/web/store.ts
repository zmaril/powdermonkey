// Zustand store: holds the board + a live action feed, kept current over the
// Eden Treaty WebSocket. API calls go through the typed Eden client (`api`).
// The board stays authoritative (refetched on each action); the action feed is
// fed incrementally from the pushed action rows.

import { create } from "zustand";
import type { ActionRecord } from "../server/repo.ts";
import type { BoardState } from "../shared/types.ts";
import { api } from "./client.ts";

interface BoardStore {
  board: BoardState | null;
  actions: ActionRecord[];
  connected: boolean;
  selectedTaskId: string | null;

  load: () => Promise<void>;
  connect: () => void;
  select: (taskId: string | null) => void;

  // operator actions
  answer: (taskId: string, answer: string) => Promise<void>;
  approve: (taskId: string) => Promise<void>;
  comment: (taskId: string, comment: string) => Promise<void>;
  markDone: (taskId: string) => Promise<void>;
  abandon: (taskId: string) => Promise<void>;
  launch: (taskId: string) => Promise<void>;
  createTask: (input: CreateTaskInput) => Promise<void>;

  // supervisor
  proposePlan: (input: ProposePlanInput) => Promise<void>;
  approvePlan: (planId: string, launch: boolean) => Promise<void>;
  rejectPlan: (planId: string) => Promise<void>;
}

export interface WorkspaceExtras {
  subpath?: string;
  secrets?: Record<string, string>;
  envFiles?: string[];
  setup?: string;
}

export interface ProposePlanInput extends WorkspaceExtras {
  workspaceId: string;
  projectName?: string;
  repoPath?: string;
  goalTitle: string;
  intent?: string;
}

export interface CreateTaskInput extends WorkspaceExtras {
  workspaceId: string;
  projectName?: string;
  repoPath?: string;
  title: string;
  objective: string;
  launchNow: boolean;
}

export const useBoard = create<BoardStore>((set, get) => {
  const refreshBoard = async () => {
    const { data } = await api.api.board.get();
    if (data) set({ board: data as BoardState });
  };
  const act = async (fn: () => Promise<unknown>) => {
    await fn();
    await refreshBoard();
  };

  const ensureWorkspace = async (input: ProposePlanInput | CreateTaskInput): Promise<string> => {
    if (!input.projectName) return input.workspaceId;
    const { data } = await api.api.workspaces.post({
      id: input.workspaceId,
      name: input.projectName,
      repoPath: input.repoPath,
      subpath: input.subpath,
      secrets: input.secrets,
      envFiles: input.envFiles,
      setup: input.setup,
    });
    return data?.id ?? input.workspaceId;
  };

  let socketOpen = false; // guard against StrictMode double-connect

  return {
    board: null,
    actions: [],
    connected: false,
    selectedTaskId: null,

    load: async () => {
      await refreshBoard();
      const { data } = await api.api.actions.get({ query: { limit: "1000" } });
      if (data) set({ actions: data as unknown as ActionRecord[] });
    },

    connect: () => {
      if (socketOpen) return;
      socketOpen = true;
      const ws = api.ws.subscribe();
      ws.on("open", () => set({ connected: true }));
      ws.on("close", () => {
        socketOpen = false;
        set({ connected: false });
        setTimeout(() => get().connect(), 1500); // auto-reconnect
      });
      ws.subscribe(({ data }) => {
        if (data?.type === "action") {
          const action = data.action as ActionRecord;
          set((s) =>
            s.actions.some((x) => x.id === action.id)
              ? s
              : { actions: [action, ...s.actions].slice(0, 1000) },
          );
          void refreshBoard(); // board stays authoritative
        }
      });
    },

    select: (taskId) => set({ selectedTaskId: taskId }),

    answer: (taskId, answer) => act(() => api.api.tasks({ id: taskId }).answer.post({ answer })),
    approve: (taskId) => act(() => api.api.tasks({ id: taskId })["approve-review"].post()),
    comment: (taskId, comment) =>
      act(() => api.api.tasks({ id: taskId }).comment.post({ comment })),
    markDone: (taskId) => act(() => api.api.tasks({ id: taskId }).done.post()),
    abandon: (taskId) => act(() => api.api.tasks({ id: taskId }).abandon.post()),
    launch: (taskId) => act(() => api.api.tasks({ id: taskId }).launch.post({})),

    createTask: async (input) => {
      const workspaceId = await ensureWorkspace(input);
      const goalId = `goal-${workspaceId}`;
      const wsId = `ws-${workspaceId}`;
      if (!get().board?.goals.find((g) => g.id === goalId)) {
        await api.api.goals.post({
          id: goalId,
          workspaceId,
          title: "Ad-hoc",
          intent: "ad-hoc tasks",
        });
        await api.api.workstreams.post({ id: wsId, goalId, title: "Ad-hoc" });
      }
      const { data } = await api.api.tasks.post({
        workstreamId: wsId,
        title: input.title,
        objective: input.objective,
        kind: "implementation",
      });
      if (input.launchNow && data?.id) await api.api.tasks({ id: data.id }).launch.post({});
      await refreshBoard();
    },

    proposePlan: async (input) => {
      const workspaceId = await ensureWorkspace(input);
      const { data } = await api.api.goals.post({
        workspaceId,
        title: input.goalTitle,
        intent: input.intent,
      });
      if (data?.id) await api.api.goals({ id: data.id }).plan.post(); // fire-and-forget; arrives over WS
      await refreshBoard();
    },

    approvePlan: (planId, launch) =>
      act(() => api.api.plans({ id: planId }).approve.post({ launch })),
    rejectPlan: (planId) => act(() => api.api.plans({ id: planId }).reject.post()),
  };
});
