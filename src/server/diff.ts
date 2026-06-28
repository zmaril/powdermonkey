// Parsing the unified-diff `patch` GitHub hands back per file (the `patch` field of
// `GET /repos/{o}/{r}/pulls/{n}/files`) into structured hunks the review pane can
// render line-by-line. Pure and dependency-free so it's trivially unit-testable —
// the network/`gh` side lives in pr-review.ts.
//
// A review comment anchors to a position in the NEW file (RIGHT side) or the OLD
// file (LEFT side) by line number, so every emitted line carries both its old and
// new line numbers; the pane keys comment threads off (path, side, line).

export type DiffLineType = "context" | "add" | "del";

export type DiffLine = {
  type: DiffLineType;
  /** The line text, without the leading +/-/space marker. */
  content: string;
  /** 1-based line number in the old (pre-image) file, or null for an added line. */
  oldLine: number | null;
  /** 1-based line number in the new (post-image) file, or null for a removed line. */
  newLine: number | null;
};

export type Hunk = {
  /** The raw `@@ -a,b +c,d @@ heading` line, kept for display. */
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
};

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parse one file's unified `patch` into hunks. A null/empty patch (binary files,
 *  pure renames, files too large for GitHub to diff) yields []. Tolerates the
 *  trailing `\ No newline at end of file` marker by ignoring it. */
export function parsePatch(patch: string | null | undefined): Hunk[] {
  if (!patch) return [];
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const raw of patch.split("\n")) {
    const m = HUNK_RE.exec(raw);
    if (m) {
      current = {
        header: raw,
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        lines: [],
      };
      oldLine = current.oldStart;
      newLine = current.newStart;
      hunks.push(current);
      continue;
    }
    if (!current) continue; // preamble before the first hunk (shouldn't happen for `patch`)
    if (raw.startsWith("\\")) continue; // "\ No newline at end of file"

    const marker = raw[0];
    const content = raw.slice(1);
    if (marker === "+") {
      current.lines.push({ type: "add", content, oldLine: null, newLine });
      newLine++;
    } else if (marker === "-") {
      current.lines.push({ type: "del", content, oldLine, newLine: null });
      oldLine++;
    } else {
      // A context line. An empty string (the final split artifact) is skipped.
      if (raw === "") continue;
      current.lines.push({ type: "context", content, oldLine, newLine });
      oldLine++;
      newLine++;
    }
  }
  return hunks;
}
