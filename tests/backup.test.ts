import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { dumpSnapshot, restoreSnapshot, type SqlClient } from "../src/server/backup.ts";

// Backup is a logical (row-level) snapshot, so it round-trips through plain SQL and is
// version-independent — the property the DB upgrade relies on. These tests use two raw
// in-memory PGlite stores (schema built by replaying the migrations) rather than the
// shared db.ts store, since restore needs a second, empty target.
const migrations = readdirSync("drizzle")
  .filter((f) => /^\d+_.*\.sql$/.test(f))
  .sort();

async function migrated(): Promise<PGlite> {
  const db = new PGlite();
  for (const f of migrations) {
    await db.exec(readFileSync(`drizzle/${f}`, "utf8").replaceAll("--> statement-breakpoint", ""));
  }
  return db;
}

test("dump→restore round-trips ids, FKs, jsonb and bigint into a fresh store", async () => {
  const src = await migrated();
  await src.exec("INSERT INTO goals (title,objective) VALUES ('G','o')");
  await src.exec("INSERT INTO milestones (goal_id,title,position) SELECT id,'M',0 FROM goals");
  await src.exec(
    `INSERT INTO proposals (title,summary,status,changes,base,source_comment_id)
     VALUES ('P','s','pending','[{"op":"create"}]'::jsonb,'{"k":"v"}'::jsonb,4827711718)`,
  );
  const snap = await dumpSnapshot(src as unknown as SqlClient, "2026-07-02T00:00:00Z");

  const dst = await migrated();
  const n = await restoreSnapshot(dst as unknown as SqlClient, snap);
  expect(n).toBeGreaterThanOrEqual(3);

  const g = (await dst.query("SELECT id,title FROM goals")).rows[0] as { id: number };
  const m = (await dst.query("SELECT goal_id FROM milestones")).rows[0] as { goal_id: number };
  const p = (await dst.query("SELECT source_comment_id, changes, base FROM proposals"))
    .rows[0] as { source_comment_id: number; changes: unknown; base: unknown };
  expect(m.goal_id).toBe(g.id); // FK preserved
  expect(Number(p.source_comment_id)).toBe(4827711718); // bigint preserved (would overflow int4)
  expect(p.changes).toEqual([{ op: "create" }]); // jsonb preserved
  expect(p.base).toEqual({ k: "v" });

  // identity sequence advanced past the loaded ids — a new insert must not collide
  await dst.exec("INSERT INTO goals (title,objective) VALUES ('G2','o2')");
  const ids = (await dst.query("SELECT id FROM goals ORDER BY id")).rows.map(
    (r) => (r as { id: number }).id,
  );
  expect(new Set(ids).size).toBe(ids.length);

  await src.close();
  await dst.close();
});

test("restore refuses to clobber a non-empty store", async () => {
  const src = await migrated();
  await src.exec("INSERT INTO goals (title,objective) VALUES ('G','o')");
  const snap = await dumpSnapshot(src as unknown as SqlClient, "t");
  await expect(restoreSnapshot(src as unknown as SqlClient, snap)).rejects.toThrow(/already has/);
  await src.close();
});
