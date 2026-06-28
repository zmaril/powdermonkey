import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// diffCloudPrs is the pure heart of the watcher — given last-seen PRs and a fresh
// fetch, decide what events to emit. No DB, no network: just the classification.
// Importing the module still transitively opens db.ts (subscribers use the task
// repo), so isolate it to a throwaway data dir to avoid the writer lock.
process.env.PM_DATA_DIR = join(mkdtempSync(join(tmpdir(), "pm-")), "pg");
const { diffCloudPrs, parseTrailerIds, rebaseAction } = await import(
  "../src/server/github-watch.ts"
);
type CloudPr = import("../src/server/events.ts").CloudPr;

function pr(over: Partial<CloudPr> & { number: number; taskId: number }): CloudPr {
  return {
    url: `https://github.com/o/r/pull/${over.number}`,
    state: "OPEN",
    isDraft: false,
    merged: false,
    checks: null,
    mergeable: null,
    headRefName: `pm/task-${over.taskId}-slug`,
    updatedAt: "2026-06-27T00:00:00Z",
    ...over,
  };
}

const index = (prs: CloudPr[]) => new Map(prs.map((p) => [p.number, p]));

test("first sight of an open PR → pr.opened", () => {
  const evs = diffCloudPrs(new Map(), [pr({ number: 1, taskId: 10 })]);
  expect(evs).toEqual([{ type: "pr.opened", pr: pr({ number: 1, taskId: 10 }) }]);
});

test("startup catch-up: a pre-existing merged PR replays as pr.merged, not opened", () => {
  const evs = diffCloudPrs(new Map(), [
    pr({ number: 7, taskId: 110, state: "MERGED", merged: true }),
  ]);
  expect(evs.map((e) => e.type)).toEqual(["pr.merged"]);
});

test("a pre-existing closed-unmerged PR replays as pr.closed", () => {
  const evs = diffCloudPrs(new Map(), [pr({ number: 9, taskId: 5, state: "CLOSED" })]);
  expect(evs.map((e) => e.type)).toEqual(["pr.closed"]);
});

test("unchanged PR emits nothing", () => {
  const prev = index([pr({ number: 1, taskId: 10 })]);
  expect(diffCloudPrs(prev, [pr({ number: 1, taskId: 10 })])).toEqual([]);
});

test("open → merged transition emits pr.merged once", () => {
  const prev = index([pr({ number: 1, taskId: 10 })]);
  const next = [pr({ number: 1, taskId: 10, state: "MERGED", merged: true })];
  expect(diffCloudPrs(prev, next).map((e) => e.type)).toEqual(["pr.merged"]);
});

test("draft → ready (and check state) emits pr.updated", () => {
  const prev = index([pr({ number: 1, taskId: 10, isDraft: true })]);
  const next = [pr({ number: 1, taskId: 10, isDraft: false, checks: "SUCCESS" })];
  expect(diffCloudPrs(prev, next).map((e) => e.type)).toEqual(["pr.updated"]);
});

test("open → closed without merge emits pr.closed", () => {
  const prev = index([pr({ number: 1, taskId: 10 })]);
  const next = [pr({ number: 1, taskId: 10, state: "CLOSED" })];
  expect(diffCloudPrs(prev, next).map((e) => e.type)).toEqual(["pr.closed"]);
});

test("parseTrailerIds pulls PM-Task and PM-Phase ids (the branch-name fallback)", () => {
  const body = [
    "CI: lint, format & tests",
    "",
    "PM-Phase: 142",
    "PM-Phase: 143, 144",
    "PM-Task: 105",
  ].join("\n");
  expect(parseTrailerIds(body)).toEqual({ taskIds: [105], phaseIds: [142, 143, 144] });
});

test("parseTrailerIds returns empties when there are no trailers", () => {
  expect(parseTrailerIds("just a normal commit message")).toEqual({ taskIds: [], phaseIds: [] });
});

test("rebaseAction: a fresh live CONFLICTING asks, a repeat skips (no re-spam)", () => {
  expect(rebaseAction("CONFLICTING", false, false)).toBe("ask");
  expect(rebaseAction("CONFLICTING", true, false)).toBe("skip");
});

test("rebaseAction: going MERGEABLE clears the episode so a later conflict re-asks", () => {
  expect(rebaseAction("MERGEABLE", true, false)).toBe("clear");
  expect(rebaseAction("MERGEABLE", false, false)).toBe("clear");
});

test("rebaseAction: an `initial` (catch-up) CONFLICTING never asks — no boot flood/re-spam", () => {
  expect(rebaseAction("CONFLICTING", false, true)).toBe("skip");
  expect(rebaseAction("CONFLICTING", true, true)).toBe("skip");
});

// The regression durable persistence could introduce: a conflict resolved while we
// were down must still clear the ledger on the boot catch-up, or a stale "asked"
// flag would suppress the *next* real conflict. Clearing must beat the initial skip.
test("rebaseAction: MERGEABLE clears even on an `initial` event (no stale flag after restart)", () => {
  expect(rebaseAction("MERGEABLE", true, true)).toBe("clear");
});

test("rebaseAction: UNKNOWN/null is transient — never asks, never clears", () => {
  expect(rebaseAction("UNKNOWN", false, false)).toBe("skip");
  expect(rebaseAction("UNKNOWN", true, true)).toBe("skip");
  expect(rebaseAction(null, false, false)).toBe("skip");
  expect(rebaseAction(null, true, true)).toBe("skip");
});

test("only the changed PR among many emits", () => {
  const prev = index([
    pr({ number: 1, taskId: 10 }),
    pr({ number: 2, taskId: 20 }),
    pr({ number: 3, taskId: 30, state: "MERGED", merged: true }),
  ]);
  const next = [
    pr({ number: 1, taskId: 10 }), // unchanged
    pr({ number: 2, taskId: 20, merged: true, state: "MERGED" }), // merged now
    pr({ number: 3, taskId: 30, state: "MERGED", merged: true }), // unchanged
  ];
  const evs = diffCloudPrs(prev, next);
  expect(evs).toEqual([{ type: "pr.merged", pr: next[1] }]);
});
