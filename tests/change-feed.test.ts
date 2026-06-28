import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// End-to-end for the DB-driven realtime feed: a real PGlite (with the `live`
// extension + migrations) wired to the WS fan-out. A write through the Drizzle
// repos must reach a registered client as a "changed" ping — proving the per-table
// triggers fire and startChangeFeed relays them, with no manual notifyChange().

process.env.PM_DATA_DIR = join(mkdtempSync(join(tmpdir(), "pm-cf-")), "pg");
process.env.PM_TMUX_SOCKET = `pm-test-${process.pid}`;

const { ready, pg } = await import("../src/server/db.ts");
const { goalRepo, sessionRepo } = await import("../src/server/crud.ts");
const {
  startChangeFeed,
  stopChangeFeed,
  addRealtimeClient,
  removeRealtimeClient,
  CHANGED_MESSAGE,
} = await import("../src/server/realtime.ts");

beforeAll(async () => {
  await ready();
  await startChangeFeed(pg);
});
afterAll(async () => {
  await stopChangeFeed();
});

/** Run `write` with a client attached and return the pings it received, waiting up
 *  to ~1s for the trigger → notify → coalesce roundtrip. */
async function pingsFrom(write: () => Promise<unknown>): Promise<string[]> {
  const got: string[] = [];
  const key = {};
  addRealtimeClient(key, (m) => got.push(m));
  try {
    await write();
    for (let i = 0; i < 40 && got.length === 0; i++) await Bun.sleep(25);
    return got;
  } finally {
    removeRealtimeClient(key);
  }
}

test("an INSERT through a repo pushes a change ping", async () => {
  const got = await pingsFrom(() => goalRepo.create({ title: "g", objective: "" }));
  expect(got).toContain(CHANGED_MESSAGE);
});

test("an UPDATE through a repo pushes a change ping (the needs_input case)", async () => {
  const s = await sessionRepo.create({ kind: "local", state: "running" });
  const got = await pingsFrom(() => sessionRepo.update(s.id, { needsInput: true }));
  expect(got).toContain(CHANGED_MESSAGE);
});

test("no write, no ping", async () => {
  const got = await pingsFrom(async () => {
    await Bun.sleep(120);
  });
  expect(got).toEqual([]);
});

test("a cloud_prs write pushes a ping and is served by currentCloudPrs", async () => {
  const { db } = await import("../src/server/db.ts");
  const { cloudPrs } = await import("../src/server/schema.ts");
  const { currentCloudPrs } = await import("../src/server/github-watch.ts");
  const got = await pingsFrom(() =>
    db.insert(cloudPrs).values({
      number: 101,
      taskId: 1,
      url: "https://example/pr/101",
      state: "OPEN",
      isDraft: false,
      merged: false,
      checks: "PENDING",
      mergeable: "MERGEABLE",
      headRefName: "pm/task-1",
      updatedAt: "2026-06-28T00:00:00Z",
    }),
  );
  // Cloud-PR status now lives in PGlite, so its write rides the same feed.
  expect(got).toContain(CHANGED_MESSAGE);
  const prs = await currentCloudPrs();
  expect(prs.find((p) => p.number === 101)?.checks).toBe("PENDING");
});
