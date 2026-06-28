// Line-level diff of two markdown documents, grouped into hunks, so the plan review
// can offer a per-hunk "revert" in the diff gutter (undo one change back to the
// baseline) without the operator hand-editing the text. Plans are small, so a plain
// LCS over lines is more than fast enough.

export type Hunk = {
  // 1-based line ranges on each side. A pure insertion has oldCount 0; a pure
  // deletion has newCount 0. Reverting replaces the new range with the old range.
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
};

type Op = { type: "eq" | "del" | "ins" };

function lines(text: string): string[] {
  // Drop a single trailing newline so the renderer's trailing "\n" doesn't show up
  // as a phantom empty line in the diff.
  return text.replace(/\n$/, "").split("\n");
}

/** Longest-common-subsequence line ops between two texts (del = only in old, ins =
 *  only in new, eq = shared), in document order. */
function diffOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = LCS length of a[i:] and b[j:].
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "eq" });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ type: "del" });
      i++;
    } else {
      ops.push({ type: "ins" });
      j++;
    }
  }
  while (i < n) {
    ops.push({ type: "del" });
    i++;
  }
  while (j < m) {
    ops.push({ type: "ins" });
    j++;
  }
  return ops;
}

/** Group the line ops into hunks — maximal runs of non-equal lines, each a single
 *  change the gutter can revert as a unit. */
export function computeHunks(oldText: string, newText: string): Hunk[] {
  const a = lines(oldText);
  const b = lines(newText);
  const ops = diffOps(a, b);
  const hunks: Hunk[] = [];
  let oldLine = 1;
  let newLine = 1;
  let cur: Hunk | null = null;
  for (const op of ops) {
    if (op.type === "eq") {
      if (cur) {
        hunks.push(cur);
        cur = null;
      }
      oldLine++;
      newLine++;
    } else {
      if (!cur) cur = { oldStart: oldLine, oldCount: 0, newStart: newLine, newCount: 0 };
      if (op.type === "del") {
        cur.oldCount++;
        oldLine++;
      } else {
        cur.newCount++;
        newLine++;
      }
    }
  }
  if (cur) hunks.push(cur);
  return hunks;
}

/** The hunk covering a hovered diff line, or undefined. `side` follows @pierre/diffs:
 *  "additions" = the new (right) side, "deletions" = the old (left) side. */
export function hunkAt(
  hunks: Hunk[],
  side: "additions" | "deletions",
  lineNumber: number,
): Hunk | undefined {
  return hunks.find((h) =>
    side === "additions"
      ? h.newCount > 0 && lineNumber >= h.newStart && lineNumber < h.newStart + h.newCount
      : h.oldCount > 0 && lineNumber >= h.oldStart && lineNumber < h.oldStart + h.oldCount,
  );
}

/** Revert one hunk in the draft: replace its new-side lines with the baseline's
 *  old-side lines, leaving every other change intact. Returns the new draft text
 *  (trailing newline preserved). */
export function revertHunk(oldText: string, newText: string, h: Hunk): string {
  const a = lines(oldText);
  const b = lines(newText);
  const before = b.slice(0, h.newStart - 1);
  const after = b.slice(h.newStart - 1 + h.newCount);
  const replacement = a.slice(h.oldStart - 1, h.oldStart - 1 + h.oldCount);
  return `${[...before, ...replacement, ...after].join("\n")}\n`;
}
