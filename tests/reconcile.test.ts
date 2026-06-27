import { beforeAll, expect, test } from "bun:test";
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
const { reconcile } = await import("../src/server/reconcile.ts");

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

beforeAll(async () => {
  await ready();
  await git("init", "-b", "main");
  await git("commit", "--allow-empty", "-m", "root");
});

test("trailers on main mark phases done and complete tasks", async () => {
  await loadPlan(
    parsePlan({
      goals: [
        {
          title: "Recon",
          milestones: [
            {
              title: "m",
              tasks: [
                { title: "tables", phases: [{ name: "a" }, { name: "b" }] },
                { title: "endpoints", phases: [{ name: "c" }] },
              ],
            },
          ],
        },
      ],
    }),
  );

  const tasks = await taskRepo.list();
  const tables = tasks.find((t) => t.title === "tables");
  const endpoints = tasks.find((t) => t.title === "endpoints");
  if (!tables || !endpoints) throw new Error("seed failed");

  const phases = await phaseRepo.list();
  const tablesPhases = phases
    .filter((p) => p.taskId === tables.id)
    .sort((a, b) => a.position - b.position);
  const [a, b] = tablesPhases;

  // One commit finishes phase `a` only; another finishes the whole endpoints task.
  await git("commit", "--allow-empty", "-m", `do a\n\nPM-Phase: ${a.id}`);
  await git("commit", "--allow-empty", "-m", `finish endpoints\n\nPM-Task: ${endpoints.id}`);

  const result = await reconcile();
  expect(result.phaseTrailers).toContain(a.id);
  expect(result.taskTrailers).toContain(endpoints.id);

  // phase a done, phase b still todo (only a was trailered)
  expect((await phaseRepo.get(a.id))?.status).toBe("done");
  expect((await phaseRepo.get(b.id))?.status).toBe("todo");

  // tables: partial → still pending; endpoints: PM-Task shortcut → merged + phases done
  expect((await taskRepo.get(tables.id))?.status).toBe("pending");
  expect((await taskRepo.get(endpoints.id))?.status).toBe("merged");
  const endpointPhases = phases.filter((p) => p.taskId === endpoints.id);
  for (const p of endpointPhases) {
    expect((await phaseRepo.get(p.id))?.status).toBe("done");
  }
});

test("reconcile is idempotent", async () => {
  const first = await reconcile();
  const second = await reconcile();
  // nothing new to mark on the second pass
  expect(second.phasesMarked).toBe(0);
  expect(second.tasksCompleted).toBe(0);
  expect(first.phaseTrailers).toEqual(second.phaseTrailers);
});
