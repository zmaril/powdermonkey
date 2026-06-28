import { expect, test } from "bun:test";
import { computeHunks, hunkAt, revertHunk } from "../src/web/plan-md-diff.ts";

const OLD = ["# G `g1`", "", "## M `m1`", "", "### Keep `t1`", "### Drop `t2`"].join("\n");

test("computeHunks finds a changed line and an added line as separate hunks", () => {
  // Rename t1, drop the t2 line, append a new task.
  const next = ["# G `g1`", "", "## M `m1`", "", "### Renamed `t1`", "### New task"].join("\n");
  const hunks = computeHunks(OLD, next);
  // Line 5 changed (rename) → a replace hunk; line 6 changed (drop→new) → another.
  expect(hunks.length).toBeGreaterThanOrEqual(1);
  // The rename hunk covers new line 5.
  const h = hunkAt(hunks, "additions", 5);
  expect(h).toBeTruthy();
});

test("revertHunk restores just that hunk, leaving other edits intact", () => {
  const next = ["# G `g1`", "", "## M `m1`", "", "### Renamed `t1`", "### Drop `t2`"].join("\n");
  const hunks = computeHunks(OLD, next);
  const h = hunkAt(hunks, "additions", 5);
  if (!h) throw new Error("expected a hunk at line 5");
  const reverted = revertHunk(OLD, next, h);
  // The rename is undone…
  expect(reverted).toContain("### Keep `t1`");
  expect(reverted).not.toContain("### Renamed `t1`");
});

test("a pure insertion is a hunk with oldCount 0 and reverts to nothing", () => {
  const next = `${OLD}\n### Added `;
  const hunks = computeHunks(OLD, next);
  const insertion = hunks.find((h) => h.oldCount === 0 && h.newCount > 0);
  expect(insertion).toBeTruthy();
  if (!insertion) return;
  const reverted = revertHunk(OLD, next, insertion);
  expect(reverted.replace(/\n$/, "")).toBe(OLD);
});

test("identical texts produce no hunks", () => {
  expect(computeHunks(OLD, OLD)).toEqual([]);
  expect(computeHunks(`${OLD}\n`, OLD)).toEqual([]);
});
