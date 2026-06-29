import { useEffect } from "react";
import { ReviewPane } from "../panes/review";
import { useStore } from "../store.ts";

// Reviewing a PR is a focused, take-over activity, not another tab competing for the
// split — so the Review pane renders as a full-window overlay above everything (top
// bar included), driven by store.review. Esc or the pane's Close button drops back
// to the workspace. Esc is ignored while typing so it can't eat a comment draft.
export function ReviewOverlay() {
  const review = useStore((s) => s.review);
  const closeReview = useStore((s) => s.closeReview);
  useEffect(() => {
    if (!review) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t instanceof HTMLTextAreaElement || t instanceof HTMLInputElement;
      if (e.key === "Escape" && !typing) closeReview();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [review, closeReview]);
  if (!review) return null;
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "var(--pm-pane-bg)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <ReviewPane number={review.number} onClose={closeReview} />
    </div>
  );
}
