import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// diffCloudPrs is the pure heart of the watcher — given last-seen PRs and a fresh
// fetch, decide what events to emit. No DB, no network: just the classification.
// Importing the module still transitively opens db.ts (subscribers use the task
// repo), so isolate it to a throwaway data dir to avoid the writer lock.
process.env.PM_DATA_DIR = join(mkdtempSync(join(tmpdir(), "pm-")), "pg");
const { diffCloudPrs } = await import("../src/server/github-watch.ts");
type CloudPr = import("../src/server/events.ts").CloudPr;

function pr(over: Partial<CloudPr> & { number: number; taskId: number }): CloudPr {
  return {
    url: `https://github.com/o/r/pull/${over.number}`,
    state: "OPEN",
    isDraft: false,
    merged: false,
    checks: null,
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
