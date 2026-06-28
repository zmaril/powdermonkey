import { beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// pr-store persists the PR state github-watch polls, and — crucially — the rebase
// ask ledger alongside it. The invariant that lets those two share a row is that a
// poll upsert NEVER disturbs the ledger. These tests pin that, plus the round-trip
// and the mark/clear episode lifecycle, against a throwaway PGlite store.
process.env.PM_DATA_DIR = join(mkdtempSync(join(tmpdir(), "pm-")), "pg");
const { ready } = await import("../src/server/db.ts");
const { listPrs, upsertPrState, isRebaseAsked, markRebaseAsked, clearRebaseAsked } = await import(
  "../src/server/pr-store.ts"
);
type CloudPr = import("../src/server/events.ts").CloudPr;

function pr(over: Partial<CloudPr> & { number: number }): CloudPr {
  return {
    taskId: 10,
    url: `https://github.com/o/r/pull/${over.number}`,
    state: "OPEN",
    isDraft: false,
    merged: false,
    checks: null,
    mergeable: "CONFLICTING",
    headRefName: "pm/task-10-slug",
    updatedAt: "2026-06-28T00:00:00Z",
    ...over,
  };
}

beforeAll(async () => {
  await ready();
});

test("upsert round-trips through listPrs as a CloudPr", async () => {
  await upsertPrState(pr({ number: 1, checks: "SUCCESS", mergeable: "MERGEABLE" }));
  const got = (await listPrs()).find((p) => p.number === 1);
  expect(got).toEqual(pr({ number: 1, checks: "SUCCESS", mergeable: "MERGEABLE" }));
});

test("mark then clear toggles the ask ledger", async () => {
  await upsertPrState(pr({ number: 2 }));
  expect(await isRebaseAsked(2)).toBe(false);
  await markRebaseAsked(2);
  expect(await isRebaseAsked(2)).toBe(true);
  await clearRebaseAsked(2);
  expect(await isRebaseAsked(2)).toBe(false);
});

test("a later upsert (poll churn) never clobbers the rebase-ask ledger", async () => {
  await upsertPrState(pr({ number: 3, checks: "PENDING" }));
  await markRebaseAsked(3);
  // Simulate a poll tick rewriting observed state while the conflict persists.
  await upsertPrState(pr({ number: 3, checks: "FAILURE" }));
  expect(await isRebaseAsked(3)).toBe(true); // ledger survived the upsert
  const got = (await listPrs()).find((p) => p.number === 3);
  expect(got?.checks).toBe("FAILURE"); // …but the cache column did update
});

test("isRebaseAsked is false for an unknown PR", async () => {
  expect(await isRebaseAsked(99999)).toBe(false);
});
