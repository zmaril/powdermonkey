import { beforeAll, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setupTestDb, tmp } from "./db-harness.ts";

// Point the DB + cache root at scratch dirs, and clone from a LOCAL remote (no
// network): PM_CLONE_BASE + "<slug>.git" resolves to the bare repo we build below.
const cacheRoot = tmp("pm-repos-");
const remotesRoot = tmp("pm-remotes-");
process.env.PM_REPOS_DIR = cacheRoot;
process.env.PM_CLONE_BASE = `${remotesRoot}/`;

const { ready } = await setupTestDb();
const { ensureRepo, repoCachePath, repoDirForTask } = await import("../src/server/repo-cache.ts");
const { loadPlan, parsePlan } = await import("../src/server/plan.ts");
const { taskRepo, repoRepo } = await import("../src/server/crud.ts");

const SLUG = "acme/widget";

import { git } from "./git-helper.ts";

beforeAll(async () => {
  await ready();
  // Build a local "remote" the ensureRepo clone URL resolves to: <remotesRoot>/acme/widget.git
  const remote = join(remotesRoot, `${SLUG}.git`);
  const seed = tmp("pm-seed-");
  await git(seed, "init", "-b", "main");
  writeFileSync(join(seed, "README.md"), "hello\n");
  await git(seed, "add", ".");
  await git(seed, "commit", "-m", "root");
  await git(seed, "clone", "--bare", seed, remote);
}, 30_000);

test("ensureRepo clones a missing repo under the cache root", async () => {
  const res = await ensureRepo(SLUG);
  if (!res.ok) throw new Error(`${res.error}: ${res.output ?? ""}`);
  expect(res.action).toBe("cloned");
  expect(res.dir).toBe(repoCachePath(SLUG));
  expect(existsSync(join(res.dir, ".git"))).toBe(true);
  expect(existsSync(join(res.dir, "README.md"))).toBe(true);
}, 30_000);

test("ensureRepo fetches an already-cloned repo instead of re-cloning", async () => {
  const res = await ensureRepo(SLUG);
  if (!res.ok) throw new Error(`${res.error}: ${res.output ?? ""}`);
  expect(res.action).toBe("fetched");
  expect(res.dir).toBe(repoCachePath(SLUG));
}, 30_000);

test("concurrent ensureRepo calls for one slug serialize onto a single clone", async () => {
  // Fire several at once; the per-slug lock must keep them from racing on the clone.
  const results = await Promise.all([ensureRepo(SLUG), ensureRepo(SLUG), ensureRepo(SLUG)]);
  for (const r of results) {
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.dir).toBe(repoCachePath(SLUG));
  }
}, 30_000);

test("ensureRepo reports a clone failure for an unresolvable slug", async () => {
  const res = await ensureRepo("acme/does-not-exist");
  expect(res.ok).toBe(false);
}, 30_000);

test("repoDirForTask resolves a task's pinned repo to its cache clone", async () => {
  await loadPlan(
    parsePlan({
      goals: [{ title: "G", milestones: [{ title: "m", tasks: [{ title: "t", phases: [] }] }] }],
    }),
  );
  const repo = await repoRepo.create({ slug: SLUG, owner: "acme", name: "widget" });
  const [task] = await taskRepo.list();
  await taskRepo.update(task.id, { repoId: repo.id });

  const resolved = await repoDirForTask(task.id, { ensure: true });
  expect(resolved.error).toBeUndefined();
  expect(resolved.dir).toBe(repoCachePath(SLUG));
}, 30_000);

test("repoDirForTask falls back to the supervisor repo for a repo-less task", async () => {
  const [task] = await taskRepo.list();
  await taskRepo.update(task.id, { repoId: null });
  const resolved = await repoDirForTask(task.id);
  expect(resolved.dir).toBe(process.env.PM_REPO_DIR ?? process.cwd());
});
