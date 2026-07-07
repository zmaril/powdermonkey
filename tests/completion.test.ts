import { expect, test } from "bun:test";
import { setupTestDb, tmp } from "./db-harness.ts";

const repoDir = tmp("pm-repo-");
process.env.PM_REPO_DIR = repoDir;
process.env.PM_MAIN_BRANCH = "main";

const { ready } = await setupTestDb();
const { loadPlan, parsePlan } = await import("../src/server/plan.ts");
const { taskRepo, phaseRepo } = await import("../src/server/crud.ts");
const { completePhase, reopenPhase, completeTask, cancelTask, reopenTask } = await import(
  "../src/server/completion.ts"
);
const { reconcile } = await import("../src/server/reconcile.ts");
const { commitBodies } = await import("../src/server/git.ts");
const { DecisionSource, OverrideSource } = await import("../src/shared/types.ts");

await ready();

async function seedTask(title: string, phaseNames: string[]) {
  await loadPlan(
    parsePlan({
      goals: [
        {
          title: `g-${title}`,
          milestones: [
            { title: "m", tasks: [{ title, phases: phaseNames.map((name) => ({ name })) }] },
          ],
        },
      ],
    }),
  );
  const task = (await taskRepo.list()).find((t) => t.title === title);
  if (!task) throw new Error("seed failed");
  const phases = (await phaseRepo.list())
    .filter((p) => p.taskId === task.id)
    .sort((a, b) => a.position - b.position);
  return { task, phases };
}

test("completePhase stamps the caller's source and rolls up the task", async () => {
  const { task, phases } = await seedTask("one-phase", ["only"]);

  const done = await completePhase(phases[0].id, OverrideSource.Operator);
  expect(done?.status).toBe("done");
  expect(done?.decisionSource).toBe(DecisionSource.Operator);

  // The task's single phase is now done, so the task rolls up to merged — by
  // operator assertion, not reconciled.
  const after = await taskRepo.get(task.id);
  expect(after?.status).toBe("merged");
  expect(after?.decisionSource).toBe(DecisionSource.Operator);
});

test("supervisor is a distinct source", async () => {
  const { task, phases } = await seedTask("super-phase", ["x"]);
  await completePhase(phases[0].id, OverrideSource.Supervisor);
  expect((await phaseRepo.get(phases[0].id))?.decisionSource).toBe(DecisionSource.Supervisor);
  expect((await taskRepo.get(task.id))?.decisionSource).toBe(DecisionSource.Supervisor);
});

test("completePhase only rolls up once every phase is done", async () => {
  const { task, phases } = await seedTask("two-phase", ["a", "b"]);

  await completePhase(phases[0].id, OverrideSource.Operator);
  expect((await taskRepo.get(task.id))?.status).toBe("pending"); // b still todo

  await completePhase(phases[1].id, OverrideSource.Operator);
  expect((await taskRepo.get(task.id))?.status).toBe("merged");
});

test("reopenPhase walks an override phase (and its task) back", async () => {
  const { task, phases } = await seedTask("reopen-phase", ["x"]);
  await completePhase(phases[0].id, OverrideSource.Operator);
  expect((await taskRepo.get(task.id))?.status).toBe("merged");

  const reopened = await reopenPhase(phases[0].id);
  expect(reopened?.status).toBe("todo");
  expect(reopened?.decisionSource).toBeNull();
  // Task was merged purely by the override, so it drops back to pending.
  const after = await taskRepo.get(task.id);
  expect(after?.status).toBe("pending");
  expect(after?.decisionSource).toBeNull();
});

test("completeTask closes a phase-less task by hand", async () => {
  const { task } = await seedTask("phaseless", []);
  const done = await completeTask(task.id, OverrideSource.Operator);
  expect(done?.status).toBe("merged");
  expect(done?.decisionSource).toBe(DecisionSource.Operator);
});

test("completeTask closes every still-todo phase with the caller's source", async () => {
  const { task, phases } = await seedTask("close-all", ["p", "q"]);
  await completeTask(task.id, OverrideSource.Supervisor);
  for (const p of phases) {
    const row = await phaseRepo.get(p.id);
    expect(row?.status).toBe("done");
    expect(row?.decisionSource).toBe(DecisionSource.Supervisor);
  }
});

test("cancelTask closes a task as won't-do (cancelled + archived), reopen restores it", async () => {
  const { task, phases } = await seedTask("wont-do", ["a"]);
  const cancelled = await cancelTask(task.id, OverrideSource.Operator);
  expect(cancelled?.status).toBe("cancelled");
  expect(cancelled?.decisionSource).toBe(DecisionSource.Operator);
  expect(cancelled?.archivedAt).not.toBeNull(); // filed into the archive
  // Phases are left as-is — a cancelled task isn't "done".
  expect((await phaseRepo.get(phases[0].id))?.status).toBe("todo");

  const reopened = await reopenTask(task.id);
  expect(reopened?.status).toBe("pending");
  expect(reopened?.decisionSource).toBeNull();
  expect(reopened?.archivedAt).toBeNull(); // back on the board
});

test("reopen refuses reconciled work; reconcile upgrades an override phase", async () => {
  const { task, phases } = await seedTask("upgrade", ["earned"]);

  // Supervisor asserts it first.
  await completePhase(phases[0].id, OverrideSource.Supervisor);
  expect((await phaseRepo.get(phases[0].id))?.decisionSource).toBe(DecisionSource.Supervisor);

  // Then the real trailer lands on main. Reconcile must upgrade override → reconciled.
  await git("init", "-b", "main");
  await git("commit", "--allow-empty", "-m", "root");
  await git("commit", "--allow-empty", "-m", `do it\n\nPM-Phase: ${phases[0].id}`);
  await reconcile();

  const phase = await phaseRepo.get(phases[0].id);
  expect(phase?.decisionSource).toBe(DecisionSource.Reconciled);
  // The task it rolled up should be reconciled too now (all phases reconciled).
  expect((await taskRepo.get(task.id))?.decisionSource).toBe(DecisionSource.Reconciled);

  // Reopen now refuses — the work belongs to main.
  const stillDone = await reopenPhase(phases[0].id);
  expect(stillDone?.status).toBe("done");
  expect(stillDone?.decisionSource).toBe(DecisionSource.Reconciled);
  const stillMerged = await reopenTask(task.id);
  expect(stillMerged?.status).toBe("merged");

  // commitBodies sanity — the trailer is on main.
  expect(await commitBodies("main")).toContain(`PM-Phase: ${phases[0].id}`);
});

import { git as runGit } from "./git-helper.ts";
const git = (...args: string[]) => runGit(repoDir, ...args);
