import { beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { setupTestDb, tmp } from "./db-harness.ts";

// Cloud dispatch has two backends (Settings): exe.dev VM (default) and claude --remote.
// Both are exercised here without touching the network: PM_EXE_DRY_RUN fabricates the
// exe.dev worker (no `ssh exe.dev`), PM_DISPATCH_DRY_RUN fabricates the claude --remote
// session. We assert the right session URL / VM handle is persisted for each, and that
// the exe.dev backend resolves the task's GitHub slug (from its pinned repo, or the run
// dir's origin for a repo-less task).
const repoDir = tmp("pm-repo-");
process.env.PM_REPO_DIR = repoDir;
const cacheRoot = tmp("pm-repos-");
const remotesRoot = tmp("pm-remotes-");
process.env.PM_REPOS_DIR = cacheRoot;
process.env.PM_CLONE_BASE = `${remotesRoot}/`;
process.env.SHELL = "bash";
process.env.PM_EXE_DRY_RUN = "1"; // exe.dev backend: fabricate the worker, no ssh
process.env.PM_DISPATCH_DRY_RUN = "1"; // claude --remote backend: fabricate the session

const { ready } = await setupTestDb();
const { loadPlan, parsePlan } = await import("../src/server/plan.ts");
const { taskRepo, repoRepo } = await import("../src/server/crud.ts");
const { dispatchTask } = await import("../src/server/dispatch.ts");
const { setDispatchSettings } = await import("../src/server/settings.ts");

const SLUG = "acme/widget";

import { git } from "./git-helper.ts";

beforeAll(async () => {
  await ready();
  // Supervisor's own checkout (the repo-less fallback). Give it a GitHub origin so the
  // exe.dev backend can resolve a slug for a repo-less task from the run dir's remote.
  await git(repoDir, "init", "-b", "main");
  await git(repoDir, "commit", "--allow-empty", "-m", "root");
  await git(repoDir, "remote", "add", "origin", "https://github.com/acme/super.git");
  // A local "remote" ensureRepo clones the task's pinned repo from.
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

test("exe.dev backend: dispatch provisions a worker VM named for the task's repo", async () => {
  const [pinned] = (await taskRepo.list()).sort((a, b) => a.id - b.id);
  const repo = await repoRepo.create({ slug: SLUG, owner: "acme", name: "widget" });
  await taskRepo.update(pinned.id, { repoId: repo.id });

  const result = await dispatchTask(pinned.id);
  if (!result.ok) throw new Error(`${result.error}: ${result.output ?? ""}`);
  // The session is a remote run carrying its VM handle; the URL is the worker's ttyd view.
  expect(result.session.kind).toBe("remote");
  expect(result.session.vmName).toContain("widget"); // slug → repo name → VM name
  expect(result.sessionUrl).toMatch(/^https:\/\/.*\.exe\.xyz:\d+\/$/);
  expect(result.sessionUrl).toContain(result.session.vmName ?? "N/A");
}, 30_000);

test("exe.dev backend: a repo-less task resolves its slug from the run dir's origin", async () => {
  const repoless = (await taskRepo.list()).sort((a, b) => a.id - b.id)[1];
  expect(repoless.repoId).toBeNull();

  const result = await dispatchTask(repoless.id);
  if (!result.ok) throw new Error(`${result.error}: ${result.output ?? ""}`);
  // origin is github.com/acme/super → the worker is named for "super".
  expect(result.session.vmName).toContain("super");
}, 30_000);

test("claude --remote backend: dispatch records the cloud session URL, no VM", async () => {
  await setDispatchSettings({ dispatchBackend: "claude-remote" });
  try {
    const pinned = (await taskRepo.list()).sort((a, b) => a.id - b.id)[0];
    const result = await dispatchTask(pinned.id);
    if (!result.ok) throw new Error(`${result.error}: ${result.output ?? ""}`);
    expect(result.session.kind).toBe("remote");
    expect(result.session.vmName).toBeNull();
    expect(result.sessionUrl).toContain("claude.ai/code");
  } finally {
    await setDispatchSettings({ dispatchBackend: "exe-dev" });
  }
}, 30_000);
