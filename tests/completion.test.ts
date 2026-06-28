import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PM_DATA_DIR = join(mkdtempSync(join(tmpdir(), "pm-")), "pg");
const repoDir = mkdtempSync(join(tmpdir(), "pm-repo-"));
process.env.PM_REPO_DIR = repoDir;
process.env.PM_MAIN_BRANCH = "main";

const { ready } = await import("../src/server/db.ts");
const { loadPlan, parsePlan } = await import("../src/server/plan.ts");
const { taskRepo, phaseRepo } = await import("../src/server/crud.ts");
const { completePhase, reopenPhase, completeTask, reopenTask } = await import(
  "../src/server/completion.ts"
);
const { reconcile } = await import("../src/server/reconcile.ts");
const { commitBodies } = await import("../src/server/git.ts");

await ready();

async function seedTask(title: string, phaseNames: string[]) {
  await loadPlan(
    parsePlan({
      goals: [
        {
          title: `g-${title}`,
          milestones: [{ title: "m", tasks: [{ title, phases: phaseNames.map((name) => ({ name })) }] }],
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

test("completePhase stamps operator provenance and rolls up the task", async () => {
  const { task, phases } = await seedTask("one-phase", ["only"]);

  const done = await completePhase(phases[0].id);
  expect(done?.status).toBe("done");
  expect(done?.doneSource).toBe("operator");

  // The task's single phase is now done, so the task rolls up to merged — by
  // operator assertion, not reconciled.
  const after = await taskRepo.get(task.id);
  expect(after?.status).toBe("merged");
  expect(after?.doneSource).toBe("operator");
});

test("completePhase only rolls up once every phase is done", async () => {
  const { task, phases } = await seedTask("two-phase", ["a", "b"]);

  await completePhase(phases[0].id);
  expect((await taskRepo.get(task.id))?.status).toBe("pending"); // b still todo

  await completePhase(phases[1].id);
  expect((await taskRepo.get(task.id))?.status).toBe("merged");
});

test("reopenPhase walks an operator phase (and its task) back", async () => {
  const { task, phases } = await seedTask("reopen-phase", ["x"]);
  await completePhase(phases[0].id);
  expect((await taskRepo.get(task.id))?.status).toBe("merged");

  const reopened = await reopenPhase(phases[0].id);
  expect(reopened?.status).toBe("todo");
  expect(reopened?.doneSource).toBeNull();
  // Task was merged purely by the operator assertion, so it drops back to pending.
  const after = await taskRepo.get(task.id);
  expect(after?.status).toBe("pending");
  expect(after?.doneSource).toBeNull();
});

test("completeTask closes a phase-less task by hand", async () => {
  const { task } = await seedTask("phaseless", []);
  const done = await completeTask(task.id);
  expect(done?.status).toBe("merged");
  expect(done?.doneSource).toBe("operator");
});

test("completeTask closes every still-todo phase as operator", async () => {
  const { task, phases } = await seedTask("close-all", ["p", "q"]);
  await completeTask(task.id);
  for (const p of phases) {
    const row = await phaseRepo.get(p.id);
    expect(row?.status).toBe("done");
    expect(row?.doneSource).toBe("operator");
  }
});

test("reopen refuses reconciled work; reconcile upgrades an operator phase", async () => {
  const { task, phases } = await seedTask("upgrade", ["earned"]);

  // Operator asserts it first.
  await completePhase(phases[0].id);
  expect((await phaseRepo.get(phases[0].id))?.doneSource).toBe("operator");

  // Then the real trailer lands on main. Reconcile must upgrade operator → reconciled.
  await git("init", "-b", "main");
  await git("commit", "--allow-empty", "-m", "root");
  await git("commit", "--allow-empty", "-m", `do it\n\nPM-Phase: ${phases[0].id}`);
  await reconcile();

  const phase = await phaseRepo.get(phases[0].id);
  expect(phase?.doneSource).toBe("reconciled");
  // The task it rolled up should be reconciled too now (all phases reconciled).
  expect((await taskRepo.get(task.id))?.doneSource).toBe("reconciled");

  // Reopen now refuses — the work belongs to main.
  const stillDone = await reopenPhase(phases[0].id);
  expect(stillDone?.status).toBe("done");
  expect(stillDone?.doneSource).toBe("reconciled");
  const stillMerged = await reopenTask(task.id);
  expect(stillMerged?.status).toBe("merged");

  // (commitBodies sanity — keep the import used and assert the trailer is on main)
  expect(await commitBodies("main")).toContain(`PM-Phase: ${phases[0].id}`);
});

async function git(...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: repoDir,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
}
