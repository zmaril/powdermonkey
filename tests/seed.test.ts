import { beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PM_DATA_DIR = join(mkdtempSync(join(tmpdir(), "pm-")), "pg");

const { ready } = await import("../src/server/db.ts");
const { repoRepo } = await import("../src/server/crud.ts");
const { seedSupervisorRepo } = await import("../src/server/seed.ts");

// A stubbed resolver so the seed never shells out to `gh` in tests.
const resolveTo = (owner: string, name: string) => async () => ({ owner, name });

beforeAll(async () => {
  await ready();
});

test("no-ops when there's no repo to resolve", async () => {
  const row = await seedSupervisorRepo(async () => null);
  expect(row).toBeNull();
  expect(await repoRepo.list()).toHaveLength(0);
});

test("creates the supervisor's own repo, then is idempotent", async () => {
  const created = await seedSupervisorRepo(resolveTo("zmaril", "powdermonkey"));
  expect(created?.slug).toBe("zmaril/powdermonkey");
  expect(created?.owner).toBe("zmaril");
  expect(created?.name).toBe("powdermonkey");
  expect(await repoRepo.list()).toHaveLength(1);

  // Second run finds the existing row instead of inserting a duplicate.
  const again = await seedSupervisorRepo(resolveTo("zmaril", "powdermonkey"));
  expect(again?.id).toBe(created?.id);
  expect(await repoRepo.list()).toHaveLength(1);
});

test("does not resurrect a repo the operator archived", async () => {
  const created = await seedSupervisorRepo(resolveTo("zmaril", "powdermonkey"));
  await repoRepo.archive(created!.id);

  const reseed = await seedSupervisorRepo(resolveTo("zmaril", "powdermonkey"));
  // Same (still-archived) row — not a fresh live duplicate.
  expect(reseed?.id).toBe(created?.id);
  expect(reseed?.archivedAt).not.toBeNull();
  expect(await repoRepo.list()).toHaveLength(0); // still archived, excluded from the live list
  expect(await repoRepo.list({ includeArchived: true })).toHaveLength(1);
});
