import { beforeAll, expect, test } from "bun:test";
import { setupTestDb } from "./db-harness.ts";

// Isolate the store before importing anything that opens the DB.

const { ready } = await setupTestDb();
const { fanOutTasks } = await import("../src/server/fanout.ts");
const { goalRepo, milestoneRepo, taskRepo, phaseRepo, repoRepo } = await import(
  "../src/server/crud.ts"
);

let milestoneId: number;
let repoA: number;
let repoB: number;

beforeAll(async () => {
  await ready();
  const goal = await goalRepo.create({ title: "fan-out goal" });
  const ms = await milestoneRepo.create({ goalId: goal.id, title: "fan-out ms" });
  milestoneId = ms.id;
  repoA = (await repoRepo.create({ slug: "o/a", owner: "o", name: "a" })).id;
  repoB = (await repoRepo.create({ slug: "o/b", owner: "o", name: "b" })).id;
});

test("fans one task per repo, each with its own copy of the phases", async () => {
  const result = await fanOutTasks({
    milestoneId,
    title: "add the linter",
    repoIds: [repoA, repoB],
    phases: [{ name: "write tests" }, { name: "implement" }],
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;

  expect(result.tasks).toHaveLength(2);
  expect(result.tasks.map((t) => t.repoId).sort()).toEqual([repoA, repoB].sort());
  expect(result.tasks.every((t) => t.title === "add the linter")).toBe(true);
  expect(result.tasks.every((t) => t.milestoneId === milestoneId)).toBe(true);

  // Each fanned task got its OWN two phases (not shared rows).
  for (const t of result.tasks) {
    const ph = (await phaseRepo.list()).filter((p) => p.taskId === t.id);
    expect(ph.map((p) => p.name).sort()).toEqual(["implement", "write tests"]);
  }
  // Positions are distinct so they don't collide in the milestone.
  expect(new Set(result.tasks.map((t) => t.position)).size).toBe(2);
});

test("dedupes a repo picked twice — still one task for it", async () => {
  const result = await fanOutTasks({ milestoneId, title: "dedup", repoIds: [repoA, repoA] });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.tasks).toHaveLength(1);
  expect(result.tasks[0].repoId).toBe(repoA);
});

test("rejects an empty pick, an unknown milestone, and an unknown repo — writing nothing", async () => {
  const before = (await taskRepo.list()).length;

  expect((await fanOutTasks({ milestoneId, title: "x", repoIds: [] })).ok).toBe(false);
  expect((await fanOutTasks({ milestoneId: 999999, title: "x", repoIds: [repoA] })).ok).toBe(false);
  expect((await fanOutTasks({ milestoneId, title: "x", repoIds: [999999] })).ok).toBe(false);

  expect((await taskRepo.list()).length).toBe(before);
});

test("appends after existing tasks by default", async () => {
  const goal = await goalRepo.create({ title: "append goal" });
  const ms = await milestoneRepo.create({ goalId: goal.id, title: "append ms" });
  await taskRepo.create({ milestoneId: ms.id, title: "sits first", position: 0 });

  const result = await fanOutTasks({
    milestoneId: ms.id,
    title: "fanned",
    repoIds: [repoA, repoB],
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  // Appended past the existing position-0 task.
  expect(Math.min(...result.tasks.map((t) => t.position))).toBeGreaterThan(0);
});

test("stamps kind + description on every fanned task; omitted → plain task, no description", async () => {
  const result = await fanOutTasks({
    milestoneId,
    title: "hunt the crash",
    kind: "bug",
    description: "seen in prod on startup",
    repoIds: [repoA, repoB],
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.tasks.every((t) => t.kind === "bug")).toBe(true);
  expect(result.tasks.every((t) => t.description === "seen in prod on startup")).toBe(true);

  const plain = await fanOutTasks({ milestoneId, title: "no kind given", repoIds: [repoA] });
  expect(plain.ok).toBe(true);
  if (!plain.ok) return;
  expect(plain.tasks[0].kind).toBe("task");
  expect(plain.tasks[0].description).toBeNull();
});
