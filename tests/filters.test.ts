import { expect, test } from "bun:test";
import type { Session, Task } from "../src/server/schema.ts";
import { VocabKind } from "../src/shared/types.ts";
import type { Ghost } from "../src/web/ghosts.ts";
import { groupGhosts } from "../src/web/ghosts.ts";
import {
  ANY,
  DEFAULT_SESSION_FILTER,
  DEFAULT_TASK_FILTER,
  filterGhosts,
  matchGhost,
  matchSession,
  matchTask,
  parseScope,
  SessionBucket,
  scopeValue,
  sessionBucket,
  sessionInScope,
  TaskBucket,
  taskBucket,
  taskInScope,
} from "../src/web/panes/filters.ts";
import { buildIndexes } from "../src/web/plan-data.ts";

// The pure filter/search core both reframed panes slice with. These pin the bucket
// derivation (the axis the Archive tab folded into) and each filter axis, plus the
// goal/milestone scope encoding the single Select rides on.

const goal = (id: number, title = `g${id}`) =>
  ({ id, title, objective: "" }) as Parameters<typeof buildIndexes>[0][number];
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
  ({
    id,
    kind: "local",
    state: "running",
    needsInput: false,
    archivedAt: null,
    ...over,
  }) as Session;

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
  expect(
    matchTask(t, idx, new Set([1]), { ...DEFAULT_TASK_FILTER, status: TaskBucket.Active }),
  ).toBe(true);
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

// ── matchGhost / filterGhosts ──

// A proposed-new-node ghost. `kind` + `parentId` place it (a task ghost under a milestone,
// a milestone ghost under a goal, a goal ghost under nothing).
const ghost = (over: Partial<Ghost> & Pick<Ghost, "kind">): Ghost =>
  ({
    proposalId: 1,
    proposalTitle: "a proposal",
    changeIndex: 0,
    parentId: null,
    title: "new thing",
    phases: [],
    ...over,
  }) as Ghost;

test("matchGhost: text search hits the ghost title; empty query matches all", () => {
  const idx = idxOf([]);
  const g = ghost({ kind: VocabKind.Task, parentId: 1, title: "wire the dispatcher" });
  const base = { ...DEFAULT_TASK_FILTER, status: ANY };
  expect(matchGhost(g, idx, base)).toBe(true); // empty query → everything shows
  expect(matchGhost(g, idx, { ...base, search: "dispatcher" })).toBe(true);
  expect(matchGhost(g, idx, { ...base, search: "nope" })).toBe(false);
});

test("filterGhosts: a query drops non-matching standalone ghosts, keeps phase ghosts", () => {
  const idx = idxOf([]);
  const match = ghost({ kind: VocabKind.Task, parentId: 1, title: "wire the dispatcher" });
  const miss = ghost({ kind: VocabKind.Task, parentId: 1, title: "unrelated", changeIndex: 1 });
  const phase = ghost({ kind: VocabKind.Phase, parentId: 7, title: "unrelated phase" });
  const grouped = groupGhosts([match, miss, phase]);
  const filtered = filterGhosts(grouped, idx, { ...DEFAULT_TASK_FILTER, search: "dispatcher" });
  // Only the matching task ghost survives under its milestone…
  expect(filtered.tasksByMilestone.get(1)?.map((g) => g.title)).toEqual(["wire the dispatcher"]);
  // …and phase ghosts ride with their task card, untouched by the search.
  expect(filtered.phasesByTask.get(7)?.map((g) => g.title)).toEqual(["unrelated phase"]);
});

test("matchGhost: goal/milestone scope reaches through where the ghost would land", () => {
  // g1 → m1 (from idxOf); add m2 under g1 and a second goal g2/m3 so scope has somewhere to
  // miss. buildIndexes needs the extra rows, so build a wider index here.
  const idx = buildIndexes(
    [goal(1), goal(2)],
    [milestone(1, 1), milestone(2, 1), milestone(3, 2)],
    [task(50, 2)], // a real task under m2, so a phase ghost can hang off it
    [],
    [],
    [],
  );
  const base = { ...DEFAULT_TASK_FILTER, status: ANY };
  const taskGhost = ghost({ kind: VocabKind.Task, parentId: 1 }); // under m1 (goal 1)
  const milestoneGhost = ghost({ kind: VocabKind.Milestone, parentId: 1 }); // new m under goal 1
  const goalGhost = ghost({ kind: VocabKind.Goal });
  const phaseGhost = ghost({ kind: VocabKind.Phase, parentId: 50 }); // under t50 → m2 → goal 1

  // Milestone scope: only ghosts that resolve to that exact milestone show.
  expect(matchGhost(taskGhost, idx, { ...base, milestoneId: 1 })).toBe(true);
  expect(matchGhost(taskGhost, idx, { ...base, milestoneId: 2 })).toBe(false);
  expect(matchGhost(phaseGhost, idx, { ...base, milestoneId: 2 })).toBe(true);
  // A proposed NEW milestone/goal has no milestone id of its own → drops out of any
  // milestone-scoped view.
  expect(matchGhost(milestoneGhost, idx, { ...base, milestoneId: 1 })).toBe(false);
  expect(matchGhost(goalGhost, idx, { ...base, milestoneId: 1 })).toBe(false);

  // Goal scope: reaches through the milestone for a task/phase ghost, direct for a milestone
  // ghost; a new goal drops out of any goal-scoped view.
  expect(matchGhost(taskGhost, idx, { ...base, goalId: 1 })).toBe(true);
  expect(matchGhost(taskGhost, idx, { ...base, goalId: 2 })).toBe(false);
  expect(matchGhost(milestoneGhost, idx, { ...base, goalId: 1 })).toBe(true);
  expect(matchGhost(milestoneGhost, idx, { ...base, goalId: 2 })).toBe(false);
  expect(matchGhost(phaseGhost, idx, { ...base, goalId: 1 })).toBe(true);
  expect(matchGhost(goalGhost, idx, { ...base, goalId: 1 })).toBe(false);
});

test("filterGhosts: scope + search compose — a ghost must pass both", () => {
  const idx = buildIndexes([goal(1)], [milestone(1, 1), milestone(2, 1)], [], [], [], []);
  const hit = ghost({ kind: VocabKind.Task, parentId: 1, title: "wire the dispatcher" });
  const wrongMilestone = ghost({
    kind: VocabKind.Task,
    parentId: 2,
    title: "wire the dispatcher",
    changeIndex: 1,
  });
  const wrongTitle = ghost({
    kind: VocabKind.Task,
    parentId: 1,
    title: "unrelated",
    changeIndex: 2,
  });
  const grouped = groupGhosts([hit, wrongMilestone, wrongTitle]);
  const filtered = filterGhosts(grouped, idx, {
    ...DEFAULT_TASK_FILTER,
    search: "dispatcher",
    milestoneId: 1,
  });
  expect(filtered.tasksByMilestone.get(1)?.map((g) => g.title)).toEqual(["wire the dispatcher"]);
  expect(filtered.tasksByMilestone.get(2)).toBeUndefined();
});

test("filterGhosts: empty query is a pass-through — every ghost stays", () => {
  const idx = idxOf([]);
  const grouped = groupGhosts([
    ghost({ kind: VocabKind.Task, parentId: 1, title: "t" }),
    ghost({ kind: VocabKind.Milestone, parentId: 1, title: "m", changeIndex: 1 }),
    ghost({ kind: VocabKind.Goal, title: "g", changeIndex: 2 }),
  ]);
  const filtered = filterGhosts(grouped, idx, DEFAULT_TASK_FILTER);
  expect(filtered.tasksByMilestone.get(1)?.length).toBe(1);
  expect(filtered.milestonesByGoal.get(1)?.length).toBe(1);
  expect(filtered.goals.length).toBe(1);
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

// ── window repo scope ──

test("taskInScope: empty scope sees everything, a scoped window only its tabs", () => {
  const inRepo = task(1, 1, { repoId: 4 });
  const otherRepo = task(2, 1, { repoId: 9 });
  const repoless = task(3, 1, { repoId: null });
  expect(taskInScope(inRepo, [])).toBe(true);
  expect(taskInScope(repoless, [])).toBe(true);
  expect(taskInScope(inRepo, [4, 5])).toBe(true);
  expect(taskInScope(otherRepo, [4, 5])).toBe(false);
  // A repo-less task is on no tab — out of every scoped window.
  expect(taskInScope(repoless, [4, 5])).toBe(false);
});

test("sessionInScope: a session reaches the scope through its tasks", () => {
  const tasks = [task(1, 1, { repoId: 4 }), task(2, 1, { repoId: 9 })];
  expect(sessionInScope(tasks, [])).toBe(true);
  expect(sessionInScope(tasks, [9])).toBe(true); // any task on a tab pulls it in
  expect(sessionInScope(tasks, [5])).toBe(false);
  // A task-less session only shows in an unscoped window.
  expect(sessionInScope([], [])).toBe(true);
  expect(sessionInScope([], [4])).toBe(false);
});
