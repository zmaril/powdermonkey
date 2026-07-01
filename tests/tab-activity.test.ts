import { expect, test } from "bun:test";
import type { Session, Task } from "../src/server/schema.ts";
import {
  PANE_SESSIONS,
  PANE_TASKS,
  paneActivity,
  snapshotActivity,
} from "../src/web/tab-activity.ts";

// Tab indicators light up on defined edges and route to the right pane. These check
// the pure trigger core; the caller suppresses flags for whatever tab is on screen.

const session = (id: number, needsInput = false) =>
  ({ id, kind: "local", state: "running", needsInput }) as Session;
const task = (id: number, status: Task["status"]) =>
  ({ id, milestoneId: 1, title: `t${id}`, status }) as Task;

test("a new live session lights up Sessions", () => {
  const prev = snapshotActivity([], []);
  const next = snapshotActivity([session(1)], []);
  expect([...paneActivity(prev, next)]).toEqual([PANE_SESSIONS]);
});

test("a needs-you transition lights up Sessions", () => {
  const prev = snapshotActivity([session(1, false)], []);
  const next = snapshotActivity([session(1, true)], []);
  expect([...paneActivity(prev, next)]).toEqual([PANE_SESSIONS]);
});

test("an already-known, unchanged session lights up nothing", () => {
  const prev = snapshotActivity([session(1, true)], [task(1, "dispatched")]);
  const next = snapshotActivity([session(1, true)], [task(1, "dispatched")]);
  expect(paneActivity(prev, next).size).toBe(0);
});

test("task status routes to the pane it moved toward", () => {
  const prev = snapshotActivity(
    [],
    [task(1, "pending"), task(2, "dispatched"), task(3, "pending")],
  );
  const next = snapshotActivity([], [task(1, "dispatched"), task(2, "merged"), task(3, "pending")]);
  const panes = paneActivity(prev, next);
  expect(panes.has(PANE_SESSIONS)).toBe(true); // 1: pending → dispatched (Sessions)
  expect(panes.has(PANE_TASKS)).toBe(true); // 2: dispatched → merged (done lives in Tasks now)
});

test("a task rolled back to pending lights up Tasks", () => {
  const prev = snapshotActivity([], [task(1, "dispatched")]);
  const next = snapshotActivity([], [task(1, "pending")]);
  expect([...paneActivity(prev, next)]).toEqual([PANE_TASKS]);
});

test("a brand-new task (absent from prev) is not a status-change edge", () => {
  const prev = snapshotActivity([], []);
  const next = snapshotActivity([], [task(9, "pending")]);
  expect(paneActivity(prev, next).size).toBe(0);
});
