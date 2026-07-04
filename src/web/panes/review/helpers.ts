import type { GitStatus } from "@pierre/trees";
import type { ReviewComment } from "../../../server/pr-review.ts";
import type { AnnMeta, ASide, LineAnchor, Side } from "./types.ts";

// Pure helpers + constants shared across the review pane's components.

// Shiki theme @pierre/diffs renders the diff with — a dark one to match the panes.
export const DIFF_THEME = "github-dark";

/** GitHub's per-file status → the git status @pierre/trees colours rows by. */
export function mapGitStatus(status: string): GitStatus {
  switch (status) {
    case "added":
      return "added";
    case "removed":
      return "deleted";
    case "renamed":
      return "renamed";
    default:
      return "modified"; // modified / changed / copied
  }
}

export const keyOf = (path: string, a: LineAnchor) => `${path}::${a.side}::${a.line}`;

export const toASide = (s: Side): ASide => (s === "LEFT" ? "deletions" : "additions");
export const fromASide = (s: ASide): Side => (s === "deletions" ? "LEFT" : "RIGHT");

/** Parse a comment anchor key (`path::SIDE::line`) back into its parts. Filenames
 *  don't contain "::", so the trailing `::SIDE::line` is unambiguous. */
export function parseKey(key: string): AnnMeta | null {
  const m = key.match(/^(.*)::(LEFT|RIGHT)::(\d+)$/);
  return m ? { path: m[1], side: m[2] as Side, line: Number(m[3]) } : null;
}

/** Index comments by anchor (top-level only) and by parent (replies), so each line
 *  can find its threads and each thread its replies. */
export function indexComments(comments: ReviewComment[], path: string) {
  const topByAnchor = new Map<string, ReviewComment[]>();
  const repliesByParent = new Map<number, ReviewComment[]>();
  for (const c of comments) {
    if (c.path !== path) continue;
    if (c.inReplyToId != null) {
      const list = repliesByParent.get(c.inReplyToId) ?? [];
      list.push(c);
      repliesByParent.set(c.inReplyToId, list);
      continue;
    }
    if (c.line == null) continue;
    const k = keyOf(path, { side: c.side ?? "RIGHT", line: c.line });
    const list = topByAnchor.get(k) ?? [];
    list.push(c);
    topByAnchor.set(k, list);
  }
  return { topByAnchor, repliesByParent };
}

/** Rough rendered height of a patch (line count × row height), for the lazy-mount
 *  placeholder. Capped so a huge file doesn't blow out the scrollbar estimate. */
export function estimateHeight(patch: string): number {
  return Math.min(40 + patch.split("\n").length * 18, 4000);
}
