// Worker-failure visibility: the Effect-based exit classifier (worker-health.ts).
import { beforeAll, expect, test } from "bun:test";

process.env.PM_DB_DIR = "memory://";

const { initDb } = await import("../src/server/db.ts");
const repoMod = await import("../src/server/repo.ts");
const { Effect } = await import("effect");
const run = Effect.runPromise;
const repo = {
  initRepo: repoMod.initRepo,
  actionsForEntity: (...a: Parameters<typeof repoMod.actionsForEntity>) =>
    run(repoMod.actionsForEntity(...a)),
  createGoal: (...a: Parameters<typeof repoMod.createGoal>) => run(repoMod.createGoal(...a)),
  createWorkspace: (...a: Parameters<typeof repoMod.createWorkspace>) =>
    run(repoMod.createWorkspace(...a)),
  createTask: (...a: Parameters<typeof repoMod.createTask>) => run(repoMod.createTask(...a)),
  createWorkstream: (...a: Parameters<typeof repoMod.createWorkstream>) =>
    run(repoMod.createWorkstream(...a)),
  getTask: (...a: Parameters<typeof repoMod.getTask>) => run(repoMod.getTask(...a)),
};
const wh = await import("../src/server/worker-health.ts");

const M = (action: string) => ({ actor: "test", action });

beforeAll(async () => {
  await initDb();
  await repo.initRepo();
  await repo.createWorkspace(
    { id: "prj-wh", name: "wh", repoPath: "/tmp/wh" },
    M("workspace_created"),
  );
  await repo.createGoal({ id: "goal-wh", workspaceId: "prj-wh", title: "g" }, M("goal_created"));
  await repo.createWorkstream(
    { id: "ws-wh", goalId: "goal-wh", title: "w" },
    M("workstream_created"),
  );
});

const mkTask = (id: string, status: string) =>
  repo.createTask(
    { id, workstreamId: "ws-wh", title: "T", objective: "o", status: status as never },
    M("task_created"),
  );

const exit = (taskId: string, code: number, pendingResume: boolean, resume = async () => {}) =>
  wh.runWorkerExit({ taskId, code, logPath: "/tmp/x.log", pendingResume, resume });

test("exit while working → task failed + worker_failed message", async () => {
  await mkTask("t-fail", "working");
  await exit("t-fail", 1, false);
  expect((await repo.getTask("t-fail"))?.status).toBe("failed");
  const acts = await repo.actionsForEntity("task", "t-fail");
  expect(acts.some((a) => a.action === "worker_failed")).toBe(true);
});

test("exit while waiting_for_me → unchanged (expected rest)", async () => {
  await mkTask("t-wait", "waiting_for_me");
  await exit("t-wait", 0, false);
  expect((await repo.getTask("t-wait"))?.status).toBe("waiting_for_me");
});

test("pendingResume → resume() called, task not failed", async () => {
  await mkTask("t-resume", "working");
  let resumed = false;
  await exit("t-resume", 1, true, async () => {
    resumed = true;
  });
  expect(resumed).toBe(true);
  expect((await repo.getTask("t-resume"))?.status).toBe("working");
});
