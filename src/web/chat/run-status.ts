// Live status of the current assistant/supervisor run: elapsed time + the tool
// steps claude is taking, so the chat can show a "working" indicator instead of
// a blank wait. Global (one run at a time).
import { create } from "zustand";

export interface RunTool {
  id: string;
  name: string;
  done: boolean;
}

interface RunStatus {
  running: boolean;
  startedAt: number;
  hasText: boolean;
  tools: RunTool[];
}

export const useRunStatus = create<RunStatus>(() => ({
  running: false,
  startedAt: 0,
  hasText: false,
  tools: [],
}));
