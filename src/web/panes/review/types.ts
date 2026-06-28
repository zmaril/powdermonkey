// Shared types for the in-app PR review pane.

export type Side = "LEFT" | "RIGHT";
export type LineAnchor = { side: Side; line: number };

// @pierre/diffs anchors annotations by 'additions' (new/right) | 'deletions'
// (old/left); we map to/from our LEFT/RIGHT comment sides.
export type ASide = "additions" | "deletions";

export type AnnMeta = { path: string; line: number; side: Side };

// A drafted (not-yet-submitted) inline comment, accumulated locally and sent as part
// of one batched review (see ReviewPane.submit). `id` is a client-only key for removal.
export type DraftComment = {
  id: number;
  path: string;
  /** The (end) line the comment anchors to. */
  line: number;
  side: Side;
  /** First line of a multi-line comment (omit for single-line). */
  startLine?: number;
  body: string;
};
