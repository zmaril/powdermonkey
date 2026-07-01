import { expect, test } from "bun:test";
import type { Session, Task } from "../src/server/schema.ts";
import { buildIndexes } from "../src/web/plan-data.ts";
import {
  ANY,
  DEFAULT_SESSION_FILTER,
  DEFAULT_TASK_FILTER,
  SessionBucket,
  TaskBucket,
  matchSession,
  matchTask,
  parseScope,
  scopeValue,
  sessionBucket,
  taskBucket,
} from "../src/web/panes/filters.ts";

// The pure filter/search core both reframed panes slice with. These pin the bucket
// derivation (the axis the Archive tab folded into) and each filter axis, plus the
// goal/milestone scope encoding the single Select rides on.

const goal = (id: number, title = `g${id}`) => ({ id, title, objective: "" }) as Parameters<
  typeof buildIndexes
>[0][number];
const milestone = (id: number, goalId: number, title = `m${id}`) =>
  ({ id, goalId, title, position: 0 }) as Parameters<typeof buildIndexes>[1][number];
const task = (id: number, milestoneId: number, over: Partial<Task> = {}): Task =>
  ({
    id,
    milestoneId,
    title: `task ${id}`,
    position: 0,
    starred: false,
    status: "pending",
    archivedAt: null,
    ...over,
  }) as Task;
const session = (id: number, over: Partial<Session> = {}): Session =>
  ({ id, kind: "local", state: "running", needsInput: false, archivedAt: null, ...over }) as Session;

const idxOf = (
  tasks: Task[],
  sessions: Session[] = [],
  links: { sessionId: number; taskId: number }[] = [],
) => buildIndexes([goal(1)], [milestone(1, 1)], tasks, [], sessions, links);

// ── buckets ──

test("taskBucket: terminal status wins over active/archived", () => {
  const active = new Set([2]);
  expect(taskBucket(task(1, 1), active)).toBe(TaskBucket.Backlog);
  expect(taskBucket(task(2, 1), active)).toBe(TaskBucket.Active);
  expect(taskBucket(task(3, 1, { status: "merged", archivedAt: new Date() }), active)).toBe(
    TaskBucket.Finished,
  );
  expect(taskBucket(task(4, 1, { status: "cancelled", archivedAt: new Date() }), active)).toBe(
    TaskBucket.WontDo,
  );
  expect(taskBucket(task(5, 1, { archivedAt: new Date() }), active)).toBe(TaskBucket.Archived);
});

test("sessionBucket: live vs landed vs aborted", () => {
  expect(sessionBucket(session(1))).toBe(SessionBucket.Live);
  expect(sessionBucket(session(2, { state: "idle", archivedAt: new Date() }))).toBe(
    SessionBucket.Landed,
  );
  expect(sessionBucket(session(3, { state: "stopped", archivedAt: new Date() }))).toBe(
    SessionBucket.Aborted,
  );
});

// ── matchTask ──

test("matchTask: default (backlog) hides active/done; status filter widens", () => {
  const t = task(1, 1);
  const idx = idxOf([t], [session(9)], [{ sessionId: 9, taskId: 1 }]); // t1 is active
  // default backlog filter hides the active task
  expect(matchTask(t, idx, new Set([1]), DEFAULT_TASK_FILTER)).toBe(false);
  // switch to active and it shows
  expect(matchTask(t, idx, new Set([1]), { ...DEFAULT_TASK_FILTER, status: TaskBucket.Active })).toBe(
    true,
  );
  // ANY shows it regardless
  expect(matchTask(t, idx, new Set([1]), { ...DEFAULT_TASK_FILTER, status: ANY })).toBe(true);
});

test("matchTask: text search hits id and title; env reaches through the session", () => {
  const t = task(7, 1, { title: "wire the dispatcher" });
  const idx = idxOf([t], [session(9, { kind: "remote" })], [{ sessionId: 9, taskId: 7 }]);
  const base = { ...DEFAULT_TASK_FILTER, status: ANY };
  expect(matchTask(t, idx, new Set(), { ...base, search: "dispatcher" })).toBe(true);
  expect(matchTask(t, idx, new Set(), { ...base, search: "t7" })).toBe(true);
  expect(matchTask(t, idx, new Set(), { ...base, search: "nope" })).toBe(false);
  expect(matchTask(t, idx, new Set(), { ...base, env: "remote" })).toBe(true);
  expect(matchTask(t, idx, new Set(), { ...base, env: "local" })).toBe(false);
});

test("matchTask: starred and goal/milestone scope", () => {
  const t = task(3, 1, { starred: true });
  const idx = idxOf([t]);
  const base = { ...DEFAULT_TASK_FILTER, status: ANY };
  expect(matchTask(t, idx, new Set(), { ...base, starred: true })).toBe(true);
  expect(matchTask(task(4, 1), idx, new Set(), { ...base, starred: true })).toBe(false);
  expect(matchTask(t, idx, new Set(), { ...base, goalId: 1 })).toBe(true);
  expect(matchTask(t, idx, new Set(), { ...base, goalId: 99 })).toBe(false);
  expect(matchTask(t, idx, new Set(), { ...base, milestoneId: 1 })).toBe(true);
  expect(matchTask(t, idx, new Set(), { ...base, milestoneId: 99 })).toBe(false);
});

// ── matchSession ──

test("matchSession: default (live) hides landed; reaches goal/star through its tasks", () => {
  const t = task(1, 1, { starred: true });
  const landed = session(5, { state: "idle", archivedAt: new Date() });
  const idx = idxOf([t], [landed], [{ sessionId: 5, taskId: 1 }]);
  const tasks = idx.tasksBySession.get(5) ?? [];
  expect(matchSession(landed, tasks, idx, DEFAULT_SESSION_FILTER)).toBe(false); // live-only default
  expect(matchSession(landed, tasks, idx, { ...DEFAULT_SESSION_FILTER, status: ANY })).toBe(true);
  expect(
    matchSession(landed, tasks, idx, { ...DEFAULT_SESSION_FILTER, status: ANY, starred: true }),
  ).toBe(true);
  expect(
    matchSession(landed, tasks, idx, { ...DEFAULT_SESSION_FILTER, status: ANY, goalId: 1 }),
  ).toBe(true);
  expect(
    matchSession(landed, tasks, idx, { ...DEFAULT_SESSION_FILTER, status: ANY, goalId: 2 }),
  ).toBe(false);
});

// ── scope encoding ──

test("scope value round-trips goal/milestone/none", () => {
  expect(scopeValue({ goalId: null, milestoneId: null })).toBe(ANY);
  expect(scopeValue({ goalId: 3, milestoneId: null })).toBe("g:3");
  expect(scopeValue({ goalId: null, milestoneId: 7 })).toBe("m:7");
  // milestone wins when both somehow set
  expect(scopeValue({ goalId: 3, milestoneId: 7 })).toBe("m:7");
  expect(parseScope(ANY)).toEqual({ goalId: null, milestoneId: null });
  expect(parseScope("g:3")).toEqual({ goalId: 3, milestoneId: null });
  expect(parseScope("m:7")).toEqual({ goalId: null, milestoneId: 7 });
});
