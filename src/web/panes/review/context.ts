import { createContext, useContext } from "react";
import type { PrReview } from "../../../server/pr-review.ts";
import type { DraftComment, LineAnchor } from "./types.ts";

// The review's shared state, handed to the dockview panels (Description, Files) so
// each can render its slice. dockview-react renders panels through React portals,
// which preserve context from above <DockviewReact>, so this reaches them without
// threading data through panel params.
export type ReviewCtxValue = {
  review: PrReview;
  view: "unified" | "split";
  draftByKey: Map<string, DraftComment[]>;
  removeDraft: (id: number) => void;
  composeKey: string | null;
  /** First line of the in-progress comment when it spans a range (else null). */
  composeStartLine: number | null;
  /** Open the composer for a line, or a [startLine, a.line] range when startLine set. */
  onAdd: (path: string, a: LineAnchor, startLine?: number) => void;
  onCancelCompose: () => void;
  onSubmitCompose: (body: string) => void;
  onReply: (inReplyTo: number, body: string) => Promise<void>;
  posting: boolean;
  viewed: Set<string>;
  toggleViewed: (path: string) => void;
  registerFileEl: (path: string, el: HTMLDivElement | null) => void;
  scrollToFile: (path: string) => void;
};

export const ReviewCtx = createContext<ReviewCtxValue | null>(null);

export function useReviewCtx(): ReviewCtxValue {
  const c = useContext(ReviewCtx);
  if (!c) throw new Error("ReviewCtx used outside the review overlay");
  return c;
}
