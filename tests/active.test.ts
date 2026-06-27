import { expect, test } from "bun:test";
import type { Session, Task } from "../src/server/schema.ts";
import { activeTaskIds, isActive, partitionTasks } from "../src/web/active.ts";

// Active-ness is derived from sessions, not stored. These check the shared selector
// both panes read from: a task is ACTIVE iff a live session points at it. The store
// only ever hands the selector non-archived sessions (CRUD lists filter archived),
// so the selector itself just keys on a session's presence + taskId.

const session = (id: number, taskId: number | null, kind: "local" | "remote" = "local") =>
  ({ id, taskId, kind, state: "running" }) as Session;
const task = (id: number) => ({ id, milestoneId: 1, title: `t${id}`, status: "pending" }) as Task;

test("activeTaskIds collects task ids from live sessions, local or remote", () => {
  const sessions = [session(1, 10, "local"), session(2, 20, "remote"), session(3, null)];
  const ids = activeTaskIds(sessions);
  expect(ids.has(10)).toBe(true);
  expect(ids.has(20)).toBe(true);
  // a session with no task contributes nothing
  expect(ids.size).toBe(2);
  expect(isActive(10, ids)).toBe(true);
  expect(isActive(99, ids)).toBe(false);
});

test("partitionTasks splits on the derived active set and preserves order", () => {
  const tasks = [task(10), task(11), task(20), task(30)];
  const active = activeTaskIds([session(1, 10), session(2, 20)]);
  const { active: a, backlog: b } = partitionTasks(tasks, active);
  expect(a.map((t) => t.id)).toEqual([10, 20]);
  expect(b.map((t) => t.id)).toEqual([11, 30]);
});

test("no sessions → everything is backlog", () => {
  const tasks = [task(1), task(2)];
  const { active, backlog } = partitionTasks(tasks, activeTaskIds([]));
  expect(active).toHaveLength(0);
  expect(backlog).toHaveLength(2);
});
