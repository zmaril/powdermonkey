import { beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The `live` extension leaves `pg_temp*.live_query_*_view` views in the persisted data
// dir across a crash-restart; on the next boot they still depend on their base tables, so
// a column-type migration on a synced table fails ("cannot alter type of a column used by
// a view"). dropStaleLiveViews clears them before migrate() runs. Throwaway PGlite store.
process.env.PM_DATA_DIR = join(mkdtempSync(join(tmpdir(), "pm-")), "pg");
const { ready, dropStaleLiveViews, pg } = await import("../src/server/db.ts");

type ViewRow = { viewname: string };
const tempViews = async () =>
  (
    await pg.query<ViewRow>("SELECT viewname FROM pg_views WHERE schemaname LIKE 'pg_temp%'")
  ).rows.map((r) => r.viewname);

beforeAll(async () => {
  await ready();
});

test("dropStaleLiveViews removes leftover live-query views but leaves other temp views", async () => {
  await pg.exec("CREATE TEMPORARY VIEW live_query_deadbeef_view AS SELECT id FROM goals");
  await pg.exec("CREATE TEMPORARY VIEW keep_me_view AS SELECT id FROM goals");
  expect(await tempViews()).toContain("live_query_deadbeef_view");

  await dropStaleLiveViews();

  const after = await tempViews();
  expect(after).not.toContain("live_query_deadbeef_view");
  expect(after).toContain("keep_me_view"); // only live_query_* views are cleared
});

test("cleanup unblocks a column-type change a live-query view would otherwise wedge", async () => {
  // A leftover live view on the very column we're about to widen — the exact wedge.
  await pg.exec("CREATE TEMPORARY VIEW live_query_dep_view AS SELECT source_pr FROM proposals");
  await expect(
    pg.exec("ALTER TABLE proposals ALTER COLUMN source_pr SET DATA TYPE bigint"),
  ).rejects.toThrow(); // blocked while the view exists

  await dropStaleLiveViews();

  // Now it applies cleanly — no throw.
  await pg.exec("ALTER TABLE proposals ALTER COLUMN source_pr SET DATA TYPE bigint");
});
