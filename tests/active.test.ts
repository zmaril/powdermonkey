import { expect, test } from "bun:test";
import type { Session, Task } from "../src/server/schema.ts";
import {
  type SessionLink,
  activeTaskIds,
  isActive,
  partitionTasks,
  runningAgentCount,
} from "../src/web/active.ts";

// Active-ness is derived from sessions + their task links, not stored. These check
// the shared selector both panes read from: a task is ACTIVE iff a LIVE session is
// linked to it. The store only ever hands the selector non-archived sessions (CRUD
// lists filter archived), so a link counts only when its session is in that list —
// and one session can be linked to several tasks (the session_tasks join).

const session = (id: number, kind: "local" | "remote" = "local") =>
  ({ id, kind, state: "running" }) as Session;
const link = (sessionId: number, taskId: number): SessionLink => ({ sessionId, taskId });
const task = (id: number) => ({ id, milestoneId: 1, title: `t${id}`, status: "pending" }) as Task;

test("activeTaskIds collects task ids from live sessions, local or remote", () => {
  const sessions = [session(1, "local"), session(2, "remote")];
  // session 1 covers two tasks; session 3's link is dead (no live session row).
  const links = [link(1, 10), link(1, 11), link(2, 20), link(3, 30)];
  const ids = activeTaskIds(sessions, links);
  expect(ids.has(10)).toBe(true);
  expect(ids.has(11)).toBe(true);
  expect(ids.has(20)).toBe(true);
  // a link to a non-live session contributes nothing
  expect(ids.has(30)).toBe(false);
  expect(ids.size).toBe(3);
  expect(isActive(10, ids)).toBe(true);
  expect(isActive(99, ids)).toBe(false);
});

test("partitionTasks splits on the derived active set and preserves order", () => {
  const tasks = [task(10), task(11), task(20), task(30)];
  const active = activeTaskIds([session(1), session(2)], [link(1, 10), link(2, 20)]);
  const { active: a, backlog: b } = partitionTasks(tasks, active);
  expect(a.map((t) => t.id)).toEqual([10, 20]);
  expect(b.map((t) => t.id)).toEqual([11, 30]);
});

test("no sessions → everything is backlog", () => {
  const tasks = [task(1), task(2)];
  const { active, backlog } = partitionTasks(tasks, activeTaskIds([], []));
  expect(active).toHaveLength(0);
  expect(backlog).toHaveLength(2);
});

// The global status bar's live count: running agents = live (non-archived) sessions,
// local + remote alike, ignoring archived rows even when the full collection is passed.
const archived = (id: number) =>
  ({ id, kind: "local", state: "idle", archivedAt: new Date() }) as Session;

test("runningAgentCount counts live sessions of any kind", () => {
  expect(runningAgentCount([session(1, "local"), session(2, "remote")])).toBe(2);
});

test("runningAgentCount ignores archived (landed/stopped) sessions", () => {
  // The sessions collection streams live + history; only the live ones are running.
  expect(runningAgentCount([session(1), archived(2), session(3, "remote"), archived(4)])).toBe(2);
});

test("runningAgentCount is zero with no live sessions", () => {
  expect(runningAgentCount([])).toBe(0);
  expect(runningAgentCount([archived(1), archived(2)])).toBe(0);
});
