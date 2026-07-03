import { beforeAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setupTestDb, tmp } from "./db-harness.ts";
import { git } from "./git-helper.ts";

// Reconciliation loops the registered repos: each pass ensures every live repo's
// cache clone (clone/fetch), scans `origin/<defaultBranch>` for PM trailers, and
// unions the ids with the supervisor-checkout scan. These tests drive that loop
// against LOCAL bare remotes (PM_CLONE_BASE — no network): trailers landed in two
// different registered repos both mark their phases, a later push is seen on the
// next pass (fetch-to-freshness), and an unresolvable repo is skipped without
// poisoning the others.
const supervisorDir = tmp("pm-repo-");
process.env.PM_REPO_DIR = supervisorDir;
process.env.PM_MAIN_BRANCH = "main";
process.env.PM_REPOS_DIR = tmp("pm-repos-");
const remotesRoot = tmp("pm-remotes-");
process.env.PM_CLONE_BASE = `${remotesRoot}/`;

const { ready } = await setupTestDb();
const { loadPlan, parsePlan } = await import("../src/server/plan.ts");
const { phaseRepo, repoRepo, taskRepo } = await import("../src/server/crud.ts");
const { reconcile } = await import("../src/server/reconcile.ts");

// One seed working copy per remote, kept around so later tests can push more
// trailered commits to the bare remote (the fetch-to-freshness case).
const seedDirs = new Map<string, string>();

/** Build `<remotesRoot>/<slug>.git` — a bare remote a cache clone resolves to —
 *  seeded with one root commit. Returns nothing; push via commitTo. */
async function makeRemote(slug: string): Promise<void> {
  const seed = tmp("pm-seed-");
  seedDirs.set(slug, seed);
  await git(seed, "init", "-b", "main");
  writeFileSync(join(seed, "README.md"), `${slug}\n`);
  await git(seed, "add", ".");
  await git(seed, "commit", "-m", "root");
  const bare = join(remotesRoot, `${slug}.git`);
  await git(seed, "clone", "--bare", seed, bare);
  await git(seed, "remote", "add", "origin", bare);
}

/** Land a trailered commit on a remote's main — what a merged PR looks like. */
async function commitTo(slug: string, message: string): Promise<void> {
  const seed = seedDirs.get(slug);
  if (!seed) throw new Error(`no seed dir for ${slug}`);
  await git(seed, "commit", "--allow-empty", "-m", message);
  await git(seed, "push", "origin", "main");
}

beforeAll(async () => {
  await ready();
  await git(supervisorDir, "init", "-b", "main");
  await git(supervisorDir, "commit", "--allow-empty", "-m", "root");
  await makeRemote("acme/one");
  await makeRemote("acme/two");
  await loadPlan(
    parsePlan({
      goals: [
        {
          title: "Multi",
          milestones: [
            {
              title: "m",
              tasks: [
                { title: "in-one", phases: [{ name: "a" }, { name: "later" }] },
                { title: "in-two", phases: [{ name: "b" }] },
                { title: "on-super", phases: [{ name: "s" }] },
              ],
            },
          ],
        },
      ],
    }),
  );
}, 30_000);

async function phasesOf(title: string) {
  const task = (await taskRepo.list()).find((t) => t.title === title);
  if (!task) throw new Error(`no task ${title}`);
  return (await phaseRepo.list())
    .filter((p) => p.taskId === task.id)
    .sort((a, b) => a.position - b.position);
}

test("trailers landed across registered repos all mark, alongside the supervisor scan", async () => {
  await repoRepo.create({ slug: "acme/one", owner: "acme", name: "one" });
  await repoRepo.create({ slug: "acme/two", owner: "acme", name: "two" });

  const [a] = await phasesOf("in-one");
  const [b] = await phasesOf("in-two");
  const [s] = await phasesOf("on-super");

  await commitTo("acme/one", `do a\n\nPM-Phase: ${a.id}`);
  await commitTo("acme/two", `do b\n\nPM-Phase: ${b.id}`);
  await git(supervisorDir, "commit", "--allow-empty", "-m", `do s\n\nPM-Phase: ${s.id}`);

  const result = await reconcile();
  expect(result.reposScanned).toBe(2);
  expect(result.phaseTrailers).toEqual(expect.arrayContaining([a.id, b.id, s.id]));
  expect((await phaseRepo.get(a.id))?.status).toBe("done");
  expect((await phaseRepo.get(b.id))?.status).toBe("done");
  expect((await phaseRepo.get(s.id))?.status).toBe("done");
}, 30_000);

test("a later push is picked up on the next pass — the clone is fetched, not stale", async () => {
  const [, later] = await phasesOf("in-one");
  expect((await phaseRepo.get(later.id))?.status).toBe("todo");

  await commitTo("acme/one", `finish\n\nPM-Phase: ${later.id}`);
  const result = await reconcile();
  expect(result.phaseTrailers).toContain(later.id);
  expect((await phaseRepo.get(later.id))?.status).toBe("done");
}, 30_000);

test("an unresolvable repo is skipped; the rest still scan", async () => {
  await repoRepo.create({ slug: "acme/missing", owner: "acme", name: "missing" });
  const result = await reconcile();
  expect(result.reposScanned).toBe(2); // one + two — missing skipped, no throw
}, 30_000);

test("an archived repo drops out of the scan loop", async () => {
  const missing = (await repoRepo.list()).find((r) => r.slug === "acme/missing");
  const two = (await repoRepo.list()).find((r) => r.slug === "acme/two");
  if (!missing || !two) throw new Error("registry seed failed");
  await repoRepo.archive(missing.id);
  await repoRepo.archive(two.id);
  const result = await reconcile();
  expect(result.reposScanned).toBe(1); // only acme/one is still live
}, 30_000);
