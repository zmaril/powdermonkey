import { beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PM_DATA_DIR = join(mkdtempSync(join(tmpdir(), "pm-")), "pg");
const repoDir = mkdtempSync(join(tmpdir(), "pm-repo-"));
process.env.PM_REPO_DIR = repoDir;
process.env.PM_MAIN_BRANCH = "main";
process.env.PM_WORKTREE_DIR = join(mkdtempSync(join(tmpdir(), "pm-wt-")), "wt");

const { ready } = await import("../src/server/db.ts");
const { loadPlan, parsePlan } = await import("../src/server/plan.ts");
const { taskRepo, sessionRepo } = await import("../src/server/crud.ts");
const { startLocalSession, landSession } = await import("../src/server/worktree.ts");

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
  await loadPlan(
    parsePlan({
      goals: [
        {
          title: "G",
          milestones: [{ title: "m", tasks: [{ title: "t", phases: [{ name: "x" }] }] }],
        },
      ],
    }),
  );
});

test("start-local creates a worktree + branch + session row with trailer block", async () => {
  const [task] = await taskRepo.list();
  const result = await startLocalSession(task.id);
  if (!result.ok) throw new Error(result.error);

  expect(result.branch).toBe(`pm/task-${task.id}`);
  expect(existsSync(result.worktreePath)).toBe(true);
  expect(result.trailers[0]).toMatch(/^PM-Phase: \d+/);
  expect(result.prompt).toContain("PM-Phase:");

  expect(result.session.kind).toBe("local");
  expect(result.session.worktreePath).toBe(result.worktreePath);
  // dispatching moved the task off "pending"
  expect((await taskRepo.get(task.id))?.status).toBe("dispatched");
});

test("land tears down the worktree and archives the session", async () => {
  const [session] = await sessionRepo.list();
  const path = session.worktreePath;
  if (!path) throw new Error("no worktree path");

  const result = await landSession(session.id);
  if (!result.ok) throw new Error(`${result.error}: ${result.output ?? ""}`);

  expect(existsSync(path)).toBe(false);
  // archived → excluded from default list
  expect((await sessionRepo.list()).some((s) => s.id === session.id)).toBe(false);
  expect((await sessionRepo.get(session.id))?.archivedAt).toBeTruthy();
});
