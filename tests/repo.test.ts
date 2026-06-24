// Integration tests for the repository against an in-memory PGlite.
// Covers: board-state assembly, the status→column machine, soft-delete filtering,
// the per-entity diff captured in the action log, and the worker-loop status
// transitions (as data, without spawning processes).

import { beforeAll, expect, test } from "bun:test";

process.env.PM_DB_DIR = "memory://"; // in-memory; initDb reads this lazily

const { initDb } = await import("../src/server/db.ts");
const repoMod = await import("../src/server/repo.ts");
const { Effect } = await import("effect");
const run = Effect.runPromise;
// repo functions return Effects; this facade runs them so the test bodies stay plain.
const repo = {
  initRepo: repoMod.initRepo,
  getBoardState: () => run(repoMod.getBoardState()),
  actionsForEntity: (...a: Parameters<typeof repoMod.actionsForEntity>) =>
    run(repoMod.actionsForEntity(...a)),
  createArtifact: (...a: Parameters<typeof repoMod.createArtifact>) =>
    run(repoMod.createArtifact(...a)),
  createClaim: (...a: Parameters<typeof repoMod.createClaim>) => run(repoMod.createClaim(...a)),
  createGoal: (...a: Parameters<typeof repoMod.createGoal>) => run(repoMod.createGoal(...a)),
  createWorkspace: (...a: Parameters<typeof repoMod.createWorkspace>) =>
    run(repoMod.createWorkspace(...a)),
  createTask: (...a: Parameters<typeof repoMod.createTask>) => run(repoMod.createTask(...a)),
  createWorkstream: (...a: Parameters<typeof repoMod.createWorkstream>) =>
    run(repoMod.createWorkstream(...a)),
  archiveTask: (...a: Parameters<typeof repoMod.archiveTask>) => run(repoMod.archiveTask(...a)),
  updateTask: (...a: Parameters<typeof repoMod.updateTask>) => run(repoMod.updateTask(...a)),
};

const M = (action: string) => ({ actor: "test", action });

beforeAll(async () => {
  await initDb();
  await repo.initRepo();
});

// A fresh project/goal/workstream scaffold with a unique prefix per test.
async function scaffold(p: string) {
  await repo.createWorkspace(
    { id: `prj-${p}`, name: p, repoPath: `/tmp/${p}` },
    M("workspace_created"),
  );
  await repo.createGoal(
    { id: `goal-${p}`, workspaceId: `prj-${p}`, title: "g" },
    M("goal_created"),
  );
  await repo.createWorkstream(
    { id: `ws-${p}`, goalId: `goal-${p}`, title: "w" },
    M("workstream_created"),
  );
  return { workspaceId: `prj-${p}`, workstreamId: `ws-${p}` };
}

test("create flows into the board state", async () => {
  const { workspaceId, workstreamId } = await scaffold("a");
  await repo.createTask(
    { id: "task-a", workstreamId, title: "T", objective: "o" },
    M("task_created"),
  );

  const proj = await repo.getBoardState();
  expect(proj.workspaces.find((x) => x.id === workspaceId)?.name).toBe("a");
  const task = proj.tasks.find((x) => x.id === "task-a")!;
  expect(task.status).toBe("planned");
  expect(task.column).toBe("working"); // planned lives in Working
  expect(task.objective).toBe("o");
});

test("status → board column machine", async () => {
  const { workstreamId } = await scaffold("b");
  const cols: Record<string, string> = {};
  for (const status of [
    "working",
    "waiting_for_me",
    "needs_review",
    "blocked",
    "github_action",
    "done",
    "abandoned",
  ]) {
    const id = `task-b-${status}`;
    await repo.createTask({ id, workstreamId, title: status, objective: "o" }, M("task_created"));
    await repo.updateTask(id, { status }, M("status"));
    const t = (await repo.getBoardState()).tasks.find((x) => x.id === id)!;
    cols[status] = t.column;
  }
  expect(cols.working).toBe("working");
  expect(cols.github_action).toBe("working"); // CI fix is the worker's ball
  expect(cols.waiting_for_me).toBe("needs_input");
  expect(cols.needs_review).toBe("needs_input");
  expect(cols.blocked).toBe("needs_input");
  expect(cols.done).toBe("done");
  expect(cols.abandoned).toBe("done");
});

test("each mutation logs an action with the field-level diff", async () => {
  const { workstreamId } = await scaffold("c");
  await repo.createTask(
    { id: "task-c", workstreamId, title: "T", objective: "o" },
    M("task_created"),
  );
  await repo.updateTask(
    "task-c",
    { status: "needs_review", lastProgress: "ready" },
    M("worker_requested_review"),
  );

  const acts = await repo.actionsForEntity("task", "task-c"); // newest first
  const review = acts[0];
  expect(review.action).toBe("worker_requested_review");
  // the diff captures before→after for exactly the changed fields...
  expect(review.diff.status).toEqual({ from: "planned", to: "needs_review" });
  expect(review.diff.lastProgress).toEqual({ from: null, to: "ready" });
  // ...and unchanged fields are absent (title didn't change)
  expect(review.diff.title).toBeUndefined();
});

test("archive hides the row from the board state but keeps history", async () => {
  const { workstreamId } = await scaffold("d");
  await repo.createTask(
    { id: "task-d", workstreamId, title: "T", objective: "o" },
    M("task_created"),
  );
  expect((await repo.getBoardState()).tasks.some((t) => t.id === "task-d")).toBe(true);

  await repo.archiveTask("task-d", M("task_archived"));
  expect((await repo.getBoardState()).tasks.some((t) => t.id === "task-d")).toBe(false);
  // history is still there
  const acts = await repo.actionsForEntity("task", "task-d");
  expect(acts.some((a) => a.action === "task_archived")).toBe(true);
});

test("worker loop as data: planned → working → needs_review → done", async () => {
  const { workstreamId } = await scaffold("e");
  await repo.createTask(
    { id: "task-e", workstreamId, title: "T", objective: "o" },
    M("task_created"),
  );
  const col = async () => (await repo.getBoardState()).tasks.find((t) => t.id === "task-e")!.column;

  await repo.updateTask("task-e", { status: "launched" }, M("task_launched"));
  await repo.createClaim(
    { id: "clm-e", taskId: "task-e", summary: "start" },
    M("claim_registered"),
  );
  await repo.updateTask("task-e", { status: "working" }, M("claim_registered"));
  expect(await col()).toBe("working");

  await repo.updateTask(
    "task-e",
    { question: "A or B?", status: "waiting_for_me" },
    M("worker_asked_question"),
  );
  expect(await col()).toBe("needs_input");

  await repo.updateTask("task-e", { question: null, status: "working" }, M("operator_answered"));
  await repo.createArtifact(
    { id: "art-e", taskId: "task-e", kind: "pull_request", summary: "pr" },
    M("artifact_attached"),
  );
  await repo.updateTask("task-e", { status: "needs_review" }, M("worker_requested_review"));
  const proj = await repo.getBoardState();
  const t = proj.tasks.find((x) => x.id === "task-e")!;
  expect(t.column).toBe("needs_input");
  expect(t.artifacts.length).toBe(1);
  expect(t.question).toBeNull(); // cleared on answer (board read returns the row's null)

  await repo.updateTask("task-e", { status: "done" }, M("operator_marked_task_done"));
  expect(await col()).toBe("done");
});
