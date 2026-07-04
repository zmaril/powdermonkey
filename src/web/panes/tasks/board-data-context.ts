import { createContext, useContext } from "react";
import type { EntityEdit, GroupedGhosts } from "../../ghosts.ts";
import type { Indexes } from "../../plan-data.ts";

// The per-task proposal data (phases, edits, phase ghosts, phase edits) each card shows is
// computed from three board-wide maps — the plan Indexes, the grouped ghosts, and the edits
// by entity. Rather than thread those (or the derived bundle) down through the goal /
// milestone / sortable / row conduits, the board data lives at the TasksPane root and each
// leaf card reads it from context and derives its own via taskProposalProps.
export type BoardData = {
  idx: Indexes;
  ghosts: GroupedGhosts;
  edits: Map<string, EntityEdit[]>;
};

const BoardDataContext = createContext<BoardData | null>(null);

export const BoardDataProvider = BoardDataContext.Provider;

export function useBoardData(): BoardData {
  const data = useContext(BoardDataContext);
  if (!data) {
    throw new Error("useBoardData must be used within a BoardDataProvider");
  }
  return data;
}
