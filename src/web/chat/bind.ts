// A pending supervisor binding, applied to the next thread's first message.
import { create } from "zustand";

export interface ThreadBind {
  kind: "supervisor";
  goalId?: string;
  workspaceId?: string;
}

interface BindStore {
  pending: ThreadBind | null;
  setPending: (b: ThreadBind | null) => void;
}

export const useBind = create<BindStore>((set) => ({
  pending: null,
  setPending: (pending) => set({ pending }),
}));
