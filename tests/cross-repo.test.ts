import { beforeAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setupTestDb, tmp } from "./db-harness.ts";

process.env.PM_DISPATCH_DRY_RUN = "1"; // never touch the cloud from the same-repo path
// Dispatch ensures a cache clone of the task's pinned repo before the dry-run
// branch, so the repos referenced below must be cloneable. Point the cache and
// clone base at scratch dirs and build local bare remotes — no network.
const remotesRoot = tmp("pm-remotes-");
process.env.PM_REPOS_DIR = tmp("pm-repos-");
process.env.PM_CLONE_BASE = `${remotesRoot}/`;

const { ready } = await setupTestDb();
const { spansRepos, dispatchTask, CROSS_REPO_ERROR } = await import("../src/server/dispatch.ts");
const { goalRepo, milestoneRepo, taskRepo, repoRepo } = await import("../src/server/crud.ts");
import type { Task } from "../src/server/schema.ts";

const asTask = (repoId: number | null): Task => ({ repoId }) as Task;

import { git } from "./git-helper.ts";

/** Build the local bare remote PM_CLONE_BASE + "<slug>.git" resolves to. */
async function seedRemote(slug: string): Promise<void> {
  const seed = tmp("pm-seed-");
  await git(seed, "init", "-b", "main");
  writeFileSync(join(seed, "README.md"), "hello\n");
  await git(seed, "add", ".");
  await git(seed, "commit", "-m", "root");
  await git(seed, "clone", "--bare", seed, join(remotesRoot, `${slug}.git`));
}

let milestoneId: number;
let repoA: number;
let repoB: number;

beforeAll(async () => {
  await ready();
  const goal = await goalRepo.create({ title: "g" });
  milestoneId = (await milestoneRepo.create({ goalId: goal.id, title: "m" })).id;
  repoA = (await repoRepo.create({ slug: "o/a", owner: "o", name: "a" })).id;
  repoB = (await repoRepo.create({ slug: "o/b", owner: "o", name: "b" })).id;
  await seedRemote("o/a");
}, 30_000);

test("spansRepos: same repo (and all repo-less) pass; differing repos span", () => {
  expect(spansRepos([asTask(repoA), asTask(repoA)])).toBe(false);
  expect(spansRepos([asTask(null), asTask(null)])).toBe(false);
  expect(spansRepos([asTask(repoA), asTask(repoB)])).toBe(true);
  // A null repo is its own bucket — mixing repo-less with repo-pinned counts as cross-repo.
  expect(spansRepos([asTask(null), asTask(repoA)])).toBe(true);
  // A single task never spans.
  expect(spansRepos([asTask(repoA)])).toBe(false);
});

test("dispatch rejects a cross-repo multi-select and never dispatches", async () => {
  const t1 = await taskRepo.create({ milestoneId, title: "on A", repoId: repoA });
  const t2 = await taskRepo.create({ milestoneId, title: "on B", repoId: repoB });

  const result = await dispatchTask([t1.id, t2.id]);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toBe(CROSS_REPO_ERROR);

  // Neither task was moved to dispatched — the guard runs before any session is created.
  expect((await taskRepo.get(t1.id))?.sessionUrl ?? null).toBeNull();
  expect((await taskRepo.get(t2.id))?.sessionUrl ?? null).toBeNull();
});

test("dispatch allows a same-repo multi-select", async () => {
  const t1 = await taskRepo.create({ milestoneId, title: "a1", repoId: repoA });
  const t2 = await taskRepo.create({ milestoneId, title: "a2", repoId: repoA });

  const result = await dispatchTask([t1.id, t2.id]);
  expect(result.ok).toBe(true);
});
