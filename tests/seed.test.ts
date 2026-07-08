import { beforeAll, expect, test } from "bun:test";
import { setupTestDb } from "./db-harness.ts";

const { ready } = await setupTestDb();
const { repoRepo, taskRepo } = await import("../src/server/crud.ts");
const { loadPlan, parsePlan } = await import("../src/server/plan.ts");
const { seedSupervisorRepo } = await import("../src/server/seed.ts");

// A stubbed resolver so the seed never shells out to `gh` in tests.
const resolveTo = (owner: string, name: string) => async () => ({ owner, name });

beforeAll(async () => {
  await ready();
  // A pre-registry plan: tasks with no repo, waiting to be backfilled.
  await loadPlan(
    parsePlan({
      goals: [
        {
          title: "Goal A",
          milestones: [
            {
              title: "M1",
              tasks: [
                { title: "T1", phases: [{ name: "p" }] },
                { title: "T2", phases: [{ name: "p" }] },
              ],
            },
          ],
        },
      ],
    }),
  );
});

test("no-ops when there's no repo to resolve", async () => {
  const row = await seedSupervisorRepo(async () => null);
  expect(row).toBeNull();
  expect(await repoRepo.list()).toHaveLength(0);
  // Tasks stay repo-less — nothing to attach them to.
  expect((await taskRepo.list()).every((t) => t.repoId == null)).toBe(true);
});

test("creates the supervisor's own repo and backfills every repo-less task", async () => {
  const created = await seedSupervisorRepo(resolveTo("zmaril", "powdermonkey"));
  expect(created?.slug).toBe("zmaril/powdermonkey");
  expect(await repoRepo.list()).toHaveLength(1);

  // Every existing task now points at the seeded repo.
  const attached = await taskRepo.list();
  expect(attached.length).toBeGreaterThan(0);
  expect(attached.every((t) => t.repoId === created?.id)).toBe(true);
});

test("is idempotent, and does not sweep a later repo-less task onto the repo", async () => {
  const repo = (await repoRepo.list())[0];
  const [m] = await import("../src/server/crud.ts").then((m) => m.milestoneRepo.list());
  // A task authored after the upgrade, deliberately repo-less.
  const fresh = await taskRepo.create({ milestoneId: m.id, title: "post-upgrade" });
  expect(fresh.repoId).toBeNull();

  const again = await seedSupervisorRepo(resolveTo("zmaril", "powdermonkey"));
  expect(again?.id).toBe(repo.id); // found, not re-created
  expect(await repoRepo.list()).toHaveLength(1);
  // Backfill only runs on create — the fresh repo-less task is left alone.
  expect((await taskRepo.get(fresh.id))?.repoId).toBeNull();
});

test("does not resurrect a repo the operator archived", async () => {
  const repo = (await repoRepo.list())[0];
  await repoRepo.archive(repo.id);

  const reseed = await seedSupervisorRepo(resolveTo("zmaril", "powdermonkey"));
  expect(reseed?.id).toBe(repo.id);
  expect(reseed?.archivedAt).not.toBeNull();
  expect(await repoRepo.list()).toHaveLength(0); // still archived, excluded from the live list
  expect(await repoRepo.list({ includeArchived: true })).toHaveLength(1);
});
