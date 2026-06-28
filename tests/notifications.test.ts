import { expect, test } from "bun:test";
import type { Session, Task } from "../src/server/schema.ts";
import type { SessionLink } from "../src/web/active.ts";
import {
  needsInputMap,
  risingNeedsInput,
  sessionLabel,
} from "../src/web/notifications.ts";

// The notification edge detection is pure so it can be checked without a browser:
// given the previous snapshot of every session's needs-input flag and the current
// sessions, which ones JUST crossed false → true (the only thing that should fire).

const session = (id: number, needsInput: boolean) => ({ id, needsInput }) as Session;
const link = (sessionId: number, taskId: number): SessionLink => ({ sessionId, taskId });
const task = (id: number, title: string) =>
  ({ id, milestoneId: 1, title, status: "pending" }) as Task;

test("risingNeedsInput fires only on a false → true edge", () => {
  const prev = needsInputMap([session(1, false), session(2, true)]);
  // 1 rises (was false), 2 stays true (no edge), 3 is unchanged false.
  const now = [session(1, true), session(2, true), session(3, false)];
  expect(risingNeedsInput(prev, now)).toEqual([1]);
});

test("a session absent from the baseline counts as having been false", () => {
  const prev = needsInputMap([session(1, false)]);
  // session 2 is brand new and already parked → treated as a fresh edge.
  expect(risingNeedsInput(prev, [session(1, false), session(2, true)])).toEqual([2]);
});

test("a true → false edge (operator answered) does not fire", () => {
  const prev = needsInputMap([session(1, true)]);
  expect(risingNeedsInput(prev, [session(1, false)])).toEqual([]);
});

test("an empty baseline fires for every parked session", () => {
  expect(risingNeedsInput(new Map(), [session(1, true), session(2, false)])).toEqual([1]);
});

test("sessionLabel names the task(s) a session is working", () => {
  const tasks = [task(10, "Notification permission"), task(11, "Fire on edges")];
  const links = [link(1, 10), link(1, 11), link(2, 99)];
  expect(sessionLabel(1, links, tasks)).toBe("Notification permission, Fire on edges");
});

test("sessionLabel falls back to branch then id when no task matches", () => {
  const branchSession = { id: 5, branch: "pm/task-5" } as Session;
  expect(sessionLabel(5, [], [], branchSession)).toBe("pm/task-5");
  expect(sessionLabel(7, [], [])).toBe("session 7");
});
