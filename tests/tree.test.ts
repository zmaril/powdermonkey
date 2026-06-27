import { beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Goal, Milestone, Phase, Session, Task } from "../src/server/schema.ts";
import { buildTree } from "../src/shared/tree.ts";

// Isolate the store before importing anything that opens the DB.
process.env.PM_DATA_DIR = join(mkdtempSync(join(tmpdir(), "pm-")), "pg");

const { ready } = await import("../src/server/db.ts");
const { loadPlan, parsePlan } = await import("../src/server/plan.ts");
const { taskRepo, phaseRepo, sessionRepo } = await import("../src/server/crud.ts");
const { getTree } = await import("../src/server/tree.ts");

beforeAll(async () => {
  await ready();
});

// Minimal row builders — buildTree only reads the structural columns, so we fill
// those and stub the timestamp/soft-delete columns the types require.
const ts = { createdAt: new Date(0), updatedAt: new Date(0), archivedAt: null };
const goal = (id: number, extra: Partial<Goal> = {}): Goal => ({
  id,
  title: `goal ${id}`,
  objective: "",
  ...ts,
  ...extra,
});
const milestone = (id: number, goalId: number, position = 0): Milestone => ({
  id,
  goalId,
  title: `m ${id}`,
  position,
  ...ts,
});
const task = (id: number, milestoneId: number, position = 0): Task => ({
  id,
  milestoneId,
  title: `t ${id}`,
  position,
  status: "pending",
  sessionUrl: null,
  sessionState: null,
  prUrl: null,
  ...ts,
});
const phase = (id: number, taskId: number, status: "todo" | "done", position = 0): Phase => ({
  id,
  taskId,
  name: `p ${id}`,
  status,
  position,
  ...ts,
});

test("buildTree nests goals → milestones → tasks → phases", () => {
  const tree = buildTree({
    goals: [goal(1)],
    milestones: [milestone(10, 1)],
    tasks: [task(100, 10)],
    phases: [phase(1000, 100, "done"), phase(1001, 100, "todo")],
    sessions: [],
  });
  expect(tree.goals).toHaveLength(1);
  const g = tree.goals[0];
  expect(g.milestones).toHaveLength(1);
  expect(g.milestones[0].tasks).toHaveLength(1);
  expect(g.milestones[0].tasks[0].phases.map((p) => p.id)).toEqual([1000, 1001]);
});

test("rollup is computed at every level over the phases beneath it", () => {
  const tree = buildTree({
    goals: [goal(1)],
    milestones: [milestone(10, 1)],
    tasks: [task(100, 10), task(101, 10)],
    phases: [
      phase(1, 100, "done"),
      phase(2, 100, "done"),
      phase(3, 101, "done"),
      phase(4, 101, "todo"),
    ],
    sessions: [],
  });
  const g = tree.goals[0];
  const m = g.milestones[0];
  expect(m.tasks[0].rollup).toEqual({ done: 2, total: 2, pct: 100 });
  expect(m.tasks[1].rollup).toEqual({ done: 1, total: 2, pct: 50 });
  // Milestone + goal + tree rollups span all four phases (3 done of 4 = 75%).
  expect(m.rollup).toEqual({ done: 3, total: 4, pct: 75 });
  expect(g.rollup).toEqual({ done: 3, total: 4, pct: 75 });
  expect(tree.rollup).toEqual({ done: 3, total: 4, pct: 75 });
});

test("children are ordered by position, not insertion order", () => {
  const tree = buildTree({
    goals: [goal(1)],
    milestones: [milestone(10, 1, 1), milestone(11, 1, 0)],
    tasks: [task(100, 10, 2), task(101, 10, 0), task(102, 10, 1)],
    phases: [phase(1, 101, "todo", 1), phase(2, 101, "todo", 0)],
    sessions: [],
  });
  expect(tree.goals[0].milestones.map((m) => m.id)).toEqual([11, 10]);
  const tasks = tree.goals[0].milestones[1].tasks;
  expect(tasks.map((t) => t.id)).toEqual([101, 102, 100]);
  expect(tasks[0].phases.map((p) => p.id)).toEqual([2, 1]);
});

test("the latest session is attached per task; tasks without one get null", () => {
  const s = (id: number, taskId: number): Session => ({
    id,
    kind: "local",
    state: "running",
    taskId,
    branch: null,
    worktreePath: null,
    url: null,
    needsInput: false,
    ...ts,
  });
  const tree = buildTree({
    goals: [goal(1)],
    milestones: [milestone(10, 1)],
    tasks: [task(100, 10), task(101, 10, 1)],
    phases: [],
    sessions: [s(1, 100), s(2, 100)], // last one wins
  });
  const tasks = tree.goals[0].milestones[0].tasks;
  expect(tasks[0].session?.id).toBe(2);
  expect(tasks[1].session).toBeNull();
});

test("empty inputs yield an empty tree with a zero rollup", () => {
  const tree = buildTree({ goals: [], milestones: [], tasks: [], phases: [], sessions: [] });
  expect(tree.goals).toEqual([]);
  expect(tree.rollup).toEqual({ done: 0, total: 0, pct: 0 });
});

test("getTree assembles persisted rows and excludes archived by default", async () => {
  await loadPlan(
    parsePlan({
      goals: [
        {
          title: "Tree goal",
          milestones: [
            { title: "Tree milestone", tasks: [{ title: "Tree task", phases: [{ name: "ph" }] }] },
          ],
        },
      ],
    }),
  );

  const tree = await getTree();
  const g = tree.goals.find((g) => g.title === "Tree goal");
  expect(g).toBeTruthy();
  const t = g?.milestones[0].tasks[0];
  expect(t?.title).toBe("Tree task");
  expect(t?.phases).toHaveLength(1);
  expect(t?.rollup).toEqual({ done: 0, total: 1, pct: 0 });

  // Attach a session and mark the phase done; the tree reflects both.
  await sessionRepo.create({ taskId: t?.id, kind: "local", state: "running" });
  await phaseRepo.update(t?.phases[0].id as number, { status: "done" });
  const after = await getTree();
  const t2 = after.goals.find((g) => g.title === "Tree goal")?.milestones[0].tasks[0];
  expect(t2?.rollup).toEqual({ done: 1, total: 1, pct: 100 });
  expect(t2?.session?.state).toBe("running");

  // Archiving the task drops it from the default tree but appears with ?archived.
  await taskRepo.archive(t?.id as number);
  const live = await getTree();
  expect(live.goals.find((g) => g.title === "Tree goal")?.milestones[0].tasks).toHaveLength(0);
  const withArchived = await getTree({ includeArchived: true });
  expect(
    withArchived.goals.find((g) => g.title === "Tree goal")?.milestones[0].tasks,
  ).toHaveLength(1);
});
