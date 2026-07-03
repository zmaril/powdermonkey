import { beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the store before importing anything that opens the DB.
process.env.PM_DATA_DIR = join(mkdtempSync(join(tmpdir(), "pm-")), "pg");

const { ready } = await import("../src/server/db.ts");
const { loadPlan, parsePlan } = await import("../src/server/plan.ts");
const { goalRepo, milestoneRepo, taskRepo, phaseRepo, repoRepo } = await import(
  "../src/server/crud.ts"
);

beforeAll(async () => {
  await ready();
});

const nestedPlan = {
  goals: [
    {
      title: "Ship M1",
      objective: "close the loop",
      milestones: [
        {
          title: "slice",
          tasks: [
            { title: "tables", phases: [{ name: "implement" }, { name: "wire up" }] },
            { title: "endpoints", phases: [{ name: "implement" }] },
          ],
        },
      ],
    },
  ],
};

test("nested plan loads and wires foreign keys, assigning int ids", async () => {
  const counts = await loadPlan(parsePlan(nestedPlan));
  expect(counts).toEqual({ goals: 1, milestones: 1, tasks: 2, phases: 3 });

  const [goal] = await goalRepo.list();
  const milestones = await milestoneRepo.list();
  const tasks = await taskRepo.list();
  const phases = await phaseRepo.list();

  expect(typeof goal.id).toBe("number");
  expect(milestones[0].goalId).toBe(goal.id);
  expect(tasks.every((t) => milestones.some((m) => m.id === t.milestoneId))).toBe(true);
  expect(phases.every((p) => tasks.some((t) => t.id === p.taskId))).toBe(true);
  // phases default to "todo"
  expect(phases.every((p) => p.status === "todo")).toBe(true);
});

test("plan loader cascades the default repo: milestone overrides goal, task overrides both", async () => {
  const goalRepoRow = await repoRepo.create({ slug: "o/goal", owner: "o", name: "goal" });
  const msRepoRow = await repoRepo.create({ slug: "o/ms", owner: "o", name: "ms" });
  const taskRepoRow = await repoRepo.create({ slug: "o/task", owner: "o", name: "task" });

  await loadPlan(
    parsePlan({
      goals: [
        {
          title: "cascade goal",
          repoId: goalRepoRow.id,
          milestones: [
            // No milestone repo → tasks inherit the goal's.
            { title: "inherits goal", tasks: [{ title: "a" }] },
            // Milestone repo overrides the goal for its tasks, but an explicit
            // task.repoId still wins.
            {
              title: "overrides goal",
              repoId: msRepoRow.id,
              tasks: [{ title: "b" }, { title: "c", repoId: taskRepoRow.id }],
            },
          ],
        },
      ],
    }),
  );

  const byTitle = Object.fromEntries((await taskRepo.list()).map((t) => [t.title, t]));
  expect(byTitle.a.repoId).toBe(goalRepoRow.id); // inherited from the goal
  expect(byTitle.b.repoId).toBe(msRepoRow.id); // milestone overrides the goal
  expect(byTitle.c.repoId).toBe(taskRepoRow.id); // explicit task repo wins

  const ms = await milestoneRepo.list();
  expect(ms.find((m) => m.title === "overrides goal")?.repoId).toBe(msRepoRow.id);
  const goal = (await goalRepo.list()).find((g) => g.title === "cascade goal");
  expect(goal?.repoId).toBe(goalRepoRow.id);
});

test("CRUD: create, update, get", async () => {
  const goal = await goalRepo.create({ title: "G2" });
  expect(goal.id).toBeGreaterThan(0);

  const updated = await goalRepo.update(goal.id, { title: "G2 renamed" });
  expect(updated?.title).toBe("G2 renamed");

  const fetched = await goalRepo.get(goal.id);
  expect(fetched?.title).toBe("G2 renamed");
});

test("soft delete: archive hides from list, get still finds it, restore brings it back", async () => {
  const goal = await goalRepo.create({ title: "to archive" });

  const archived = await goalRepo.archive(goal.id);
  expect(archived?.archivedAt).toBeTruthy();

  const live = await goalRepo.list();
  expect(live.some((g) => g.id === goal.id)).toBe(false);

  const withArchived = await goalRepo.list({ includeArchived: true });
  expect(withArchived.some((g) => g.id === goal.id)).toBe(true);

  const restored = await goalRepo.restore(goal.id);
  expect(restored?.archivedAt).toBeNull();
  expect((await goalRepo.list()).some((g) => g.id === goal.id)).toBe(true);
});

test("plan loader carries kind + description through; omitted → plain task, no description", async () => {
  await loadPlan(
    parsePlan({
      goals: [
        {
          title: "kinds goal",
          milestones: [
            {
              title: "kinds ms",
              tasks: [
                { title: "why is it slow", kind: "spike", description: "profile before guessing" },
                { title: "just work" },
              ],
            },
          ],
        },
      ],
    }),
  );
  const tasks = await taskRepo.list();
  const spike = tasks.find((t) => t.title === "why is it slow");
  expect(spike?.kind).toBe("spike");
  expect(spike?.description).toBe("profile before guessing");
  const plain = tasks.find((t) => t.title === "just work");
  expect(plain?.kind).toBe("task");
  expect(plain?.description).toBeNull();
});

test("plan parse rejects a kind outside task|bug|spike", () => {
  expect(() =>
    parsePlan({
      goals: [
        {
          title: "g",
          milestones: [{ title: "m", tasks: [{ title: "t", kind: "chore" }] }],
        },
      ],
    }),
  ).toThrow();
});
