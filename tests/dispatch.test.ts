import { beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A dispatched session runs its PTY in the *task's* repo cache clone, so
// `claude --remote` infers the right GitHub repo from that clone's remote. We can't
// run a real `claude` here, so PM_DISPATCH_CMD is overridden to echo its own cwd
// into the "session URL" — then we assert the URL carries the cache-clone path (or,
// for a repo-less task, the supervisor's own checkout).
process.env.PM_DATA_DIR = join(mkdtempSync(join(tmpdir(), "pm-")), "pg");
const repoDir = mkdtempSync(join(tmpdir(), "pm-repo-"));
process.env.PM_REPO_DIR = repoDir;
const cacheRoot = mkdtempSync(join(tmpdir(), "pm-repos-"));
const remotesRoot = mkdtempSync(join(tmpdir(), "pm-remotes-"));
process.env.PM_REPOS_DIR = cacheRoot;
process.env.PM_CLONE_BASE = `${remotesRoot}/`;
process.env.SHELL = "bash";
// Echo the PTY's cwd into a parseable session URL. No network, no real claude.
process.env.PM_DISPATCH_CMD = 'printf "View: https://claude.ai/code%s\\n" "$PWD"';

const { ready } = await import("../src/server/db.ts");
const { loadPlan, parsePlan } = await import("../src/server/plan.ts");
const { taskRepo, repoRepo } = await import("../src/server/crud.ts");
const { repoCachePath } = await import("../src/server/repo-cache.ts");
const { dispatchTask } = await import("../src/server/dispatch.ts");

const SLUG = "acme/widget";

async function git(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
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
  // Supervisor's own checkout (the repo-less fallback target).
  await git(repoDir, "init", "-b", "main");
  await git(repoDir, "commit", "--allow-empty", "-m", "root");
  // A local "remote" ensureRepo clones the task's repo from.
  const remote = join(remotesRoot, `${SLUG}.git`);
  const seed = mkdtempSync(join(tmpdir(), "pm-seed-"));
  await git(seed, "init", "-b", "main");
  await git(seed, "commit", "--allow-empty", "-m", "root");
  await git(seed, "clone", "--bare", seed, remote);

  await loadPlan(
    parsePlan({
      goals: [
        {
          title: "G",
          milestones: [
            {
              title: "m",
              tasks: [
                { title: "pinned", phases: [{ name: "x" }] },
                { title: "repoless", phases: [{ name: "y" }] },
              ],
            },
          ],
        },
      ],
    }),
  );
}, 30_000);

test("dispatch runs in the task's repo cache clone", async () => {
  const [pinned] = (await taskRepo.list()).sort((a, b) => a.id - b.id);
  const repo = await repoRepo.create({ slug: SLUG, owner: "acme", name: "widget" });
  await taskRepo.update(pinned.id, { repoId: repo.id });

  const result = await dispatchTask(pinned.id);
  if (!result.ok) throw new Error(`${result.error}: ${result.output ?? ""}`);
  // The echoed cwd (in the session URL) is the cache clone, not the supervisor repo.
  expect(result.sessionUrl).toContain(repoCachePath(SLUG));
  expect(result.sessionUrl).not.toContain(repoDir);
}, 30_000);

test("dispatch falls back to the supervisor checkout for a repo-less task", async () => {
  const tasks = (await taskRepo.list()).sort((a, b) => a.id - b.id);
  const repoless = tasks[1];
  expect(repoless.repoId).toBeNull();

  const result = await dispatchTask(repoless.id);
  if (!result.ok) throw new Error(`${result.error}: ${result.output ?? ""}`);
  expect(result.sessionUrl).toContain(repoDir);
}, 30_000);
