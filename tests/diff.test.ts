import { expect, test } from "bun:test";
import { parsePatch } from "../src/server/diff.ts";

// parsePatch is the pure heart of the review pane — turn the GitHub per-file `patch`
// string into structured hunks with correct old/new line numbers, which is what
// inline comments anchor to. No network, no `gh`: just the parse.

test("empty / binary patch yields no hunks", () => {
  expect(parsePatch(null)).toEqual([]);
  expect(parsePatch(undefined)).toEqual([]);
  expect(parsePatch("")).toEqual([]);
});

test("a single hunk tracks old and new line numbers per line", () => {
  const patch = ["@@ -1,3 +1,4 @@", " a", "-b", "+B", "+b2", " c"].join("\n");
  const [hunk] = parsePatch(patch);
  expect(hunk.header).toBe("@@ -1,3 +1,4 @@");
  expect({ os: hunk.oldStart, ol: hunk.oldLines, ns: hunk.newStart, nl: hunk.newLines }).toEqual({
    os: 1,
    ol: 3,
    ns: 1,
    nl: 4,
  });
  expect(hunk.lines).toEqual([
    { type: "context", content: "a", oldLine: 1, newLine: 1 },
    { type: "del", content: "b", oldLine: 2, newLine: null },
    { type: "add", content: "B", oldLine: null, newLine: 2 },
    { type: "add", content: "b2", oldLine: null, newLine: 3 },
    { type: "context", content: "c", oldLine: 3, newLine: 4 },
  ]);
});

test("multiple hunks restart their line counters from each header", () => {
  const patch = ["@@ -1,1 +1,1 @@", "-x", "+X", "@@ -10,2 +10,2 @@", " y", "-z", "+Z"].join("\n");
  const hunks = parsePatch(patch);
  expect(hunks).toHaveLength(2);
  expect(hunks[1].lines[0]).toEqual({ type: "context", content: "y", oldLine: 10, newLine: 10 });
  expect(hunks[1].lines[2]).toEqual({ type: "add", content: "Z", oldLine: null, newLine: 11 });
});

test("a single-line hunk header (no count) defaults its length to 1", () => {
  const [hunk] = parsePatch(["@@ -5 +5 @@", "-old", "+new"].join("\n"));
  expect({ ol: hunk.oldLines, nl: hunk.newLines }).toEqual({ ol: 1, nl: 1 });
  expect(hunk.lines[0]).toEqual({ type: "del", content: "old", oldLine: 5, newLine: null });
});

test("the no-newline-at-eof marker is ignored, not treated as a line", () => {
  const patch = ["@@ -1,1 +1,1 @@", "-a", "\\ No newline at end of file", "+a"].join("\n");
  const [hunk] = parsePatch(patch);
  expect(hunk.lines.map((l) => l.type)).toEqual(["del", "add"]);
});

test("a section heading after @@ is kept on the header but doesn't break parsing", () => {
  const [hunk] = parsePatch(["@@ -1,2 +1,2 @@ function foo()", " a", "+b"].join("\n"));
  expect(hunk.header).toBe("@@ -1,2 +1,2 @@ function foo()");
  expect(hunk.lines).toHaveLength(2);
});
