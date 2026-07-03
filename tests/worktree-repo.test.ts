import { beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setupTestDb, tmp } from "./db-harness.ts";

// start-local against a task pinned to a Repo cuts `pm/task-<id>` from that repo's
// cache clone under ~/.powdermonkey/repos — NOT the supervisor's own checkout — and
// land removes it from that same clone. The repo is cloned from a local remote so no
// network is touched. (tests/worktree.test.ts covers the repo-less fallback.)
const repoDir = tmp("pm-repo-");
process.env.PM_REPO_DIR = repoDir;
process.env.PM_MAIN_BRANCH = "main";
process.env.PM_WORKTREE_DIR = join(tmp("pm-wt-"), "wt");
const cacheRoot = tmp("pm-repos-");
const remotesRoot = tmp("pm-remotes-");
process.env.PM_REPOS_DIR = cacheRoot;
process.env.PM_CLONE_BASE = `${remotesRoot}/`;
process.env.PM_TMUX_SOCKET = `pm-test-${process.pid}`;
process.env.PM_SESSION_CMD = "";

const { ready } = await setupTestDb();
const { loadPlan, parsePlan } = await import("../src/server/plan.ts");
const { taskRepo, sessionRepo, repoRepo } = await import("../src/server/crud.ts");
const { startLocalSession, landSession } = await import("../src/server/worktree.ts");
const { repoCachePath } = await import("../src/server/repo-cache.ts");

const SLUG = "acme/widget";

import { git } from "./git-helper.ts";

async function gitOut(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

beforeAll(async () => {
  await ready();
  // A local "remote" for the task's repo.
  const remote = join(remotesRoot, `${SLUG}.git`);
  const seed = tmp("pm-seed-");
  await git(seed, "init", "-b", "main");
  await git(seed, "commit", "--allow-empty", "-m", "root");
  await git(seed, "clone", "--bare", seed, remote);

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
  const repo = await repoRepo.create({ slug: SLUG, owner: "acme", name: "widget" });
  const [task] = await taskRepo.list();
  await taskRepo.update(task.id, { repoId: repo.id });
}, 30_000);

test("start-local cuts the worktree from the task's cache clone, and land removes it", async () => {
  const [task] = await taskRepo.list();
  const result = await startLocalSession(task.id);
  if (!result.ok) throw new Error(`${result.error}: ${result.output ?? ""}`);

  expect(result.branch).toBe(`pm/task-${task.id}`);
  expect(existsSync(result.worktreePath)).toBe(true);

  // The worktree belongs to the cache clone, not the supervisor's own repo: git lists
  // it under the cache clone, and the supervisor repo knows nothing about it.
  const cacheClone = repoCachePath(SLUG);
  const cacheWorktrees = await gitOut(cacheClone, "worktree", "list");
  expect(cacheWorktrees).toContain(result.worktreePath);

  // land removes it cleanly (run from the owning clone) and archives the session.
  const landed = await landSession(result.session.id);
  if (!landed.ok) throw new Error(`${landed.error}: ${landed.output ?? ""}`);
  expect(existsSync(result.worktreePath)).toBe(false);
  expect((await sessionRepo.get(result.session.id))?.archivedAt).toBeTruthy();
}, 30_000);
