// Logical backup / restore for the PGlite store.
//
// The snapshot is a JSON document of every row in every table — deliberately NOT
// PGlite's binary `dumpDataDir()` tarball, because that's tied to the embedded
// Postgres version and can't cross a PGlite major upgrade (0.2 → 0.5 changes the on-
// disk format). A logical snapshot round-trips through plain SQL, so it's version-
// independent: it powers on-demand backups, restores, AND the cross-version DB upgrade
// (dump on the old version → restore on the new one). See docs — the upgrade path is
// backup → bump the dep → restore into a fresh store.
//
// Restore preserves primary-key ids and foreign keys (it bulk-loads with FK triggers
// suspended and OVERRIDING SYSTEM VALUE for identity columns), then bumps each identity
// sequence past the max id so new rows don't collide.

import pkg from "../../package.json" with { type: "json" };

/** The minimal PGlite surface backup needs — satisfied by the raw client (`pg`). */
export type SqlClient = {
  query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  exec: (sql: string) => Promise<unknown>;
};

export type Snapshot = {
  meta: { pmVersion: string; takenAt: string; tables: string[] };
  data: Record<string, Record<string, unknown>[]>;
};

type ColInfo = { column_name: string; data_type: string; is_identity: string };

/** User base tables, excluding drizzle's migration bookkeeping. */
async function userTables(pg: SqlClient): Promise<string[]> {
  const { rows } = await pg.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       AND table_name <> '__drizzle_migrations'
     ORDER BY table_name`,
  );
  return rows.map((r) => r.table_name);
}

async function columns(pg: SqlClient, table: string): Promise<ColInfo[]> {
  const { rows } = await pg.query<ColInfo>(
    `SELECT column_name, data_type, is_identity FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    [table],
  );
  return rows;
}

/** The primary-key columns of `table`, in key order. Used to order the dump
 *  deterministically so `dump → restore → dump` is byte-stable — the property the
 *  round-trip test relies on (a table without an ORDER BY hands back rows in heap
 *  order, which shifts after a reload). Empty only for a hypothetical PK-less table. */
async function primaryKey(pg: SqlClient, table: string): Promise<string[]> {
  const { rows } = await pg.query<{ column_name: string }>(
    `SELECT kcu.column_name
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
     WHERE tc.constraint_type = 'PRIMARY KEY'
       AND tc.table_schema = 'public' AND tc.table_name = $1
     ORDER BY kcu.ordinal_position`,
    [table],
  );
  return rows.map((r) => r.column_name);
}

/** Dump every table's rows to a version-independent JSON snapshot. `takenAt` is
 *  passed in (the caller stamps the time) so this stays a pure transform. Rows are
 *  ordered by primary key, so two dumps of the same data are identical byte-for-byte. */
export async function dumpSnapshot(pg: SqlClient, takenAt: string): Promise<Snapshot> {
  const tables = await userTables(pg);
  const data: Record<string, Record<string, unknown>[]> = {};
  for (const t of tables) {
    const pk = await primaryKey(pg, t);
    const order = pk.length > 0 ? `ORDER BY ${pk.map((c) => `"${c}"`).join(",")}` : "";
    data[t] = (await pg.query(`SELECT * FROM "${t}" ${order}`)).rows;
  }
  return { meta: { pmVersion: pkg.version, takenAt, tables }, data };
}

/** Canonical JSON for a snapshot's *data* — the losslessness-relevant part, with
 *  `meta.takenAt` (which changes every dump) excluded. Two dumps of identical data
 *  serialize identically, so equality is a cheap `===`. This is what the round-trip
 *  test and the autosync change-detector compare on. */
export function snapshotDataJson(snap: Snapshot): string {
  return JSON.stringify(snap.data);
}

/** Restore a snapshot into an EMPTY, freshly-migrated store. Refuses if any target
 *  table already has rows, so it can never silently clobber a live store. */
export async function restoreSnapshot(pg: SqlClient, snap: Snapshot): Promise<number> {
  // Guard: every table we're about to load must be empty.
  for (const t of Object.keys(snap.data)) {
    const { rows } = await pg.query<{ n: number }>(`SELECT count(*)::int n FROM "${t}"`);
    if (rows[0].n > 0) {
      throw new Error(
        `restore refused: table "${t}" already has ${rows[0].n} rows. Restore only into a fresh store.`,
      );
    }
  }

  // Bulk-load with FK triggers suspended, so table order doesn't matter.
  await pg.exec("SET session_replication_role = replica");
  let total = 0;
  try {
    for (const [table, rows] of Object.entries(snap.data)) {
      if (rows.length === 0) continue;
      const cols = await columns(pg, table);
      const hasIdentity = cols.some((c) => c.is_identity === "YES");
      const names = cols.map((c) => c.column_name);
      const overriding = hasIdentity ? "OVERRIDING SYSTEM VALUE" : "";
      for (const row of rows) {
        const placeholders = cols.map((c, i) =>
          c.data_type === "jsonb" ? `$${i + 1}::jsonb` : `$${i + 1}`,
        );
        const values = cols.map((c) =>
          c.data_type === "jsonb" ? JSON.stringify(row[c.column_name]) : row[c.column_name],
        );
        await pg.query(
          `INSERT INTO "${table}" (${names.map((n) => `"${n}"`).join(",")})
           ${overriding} VALUES (${placeholders.join(",")})`,
          values,
        );
        total++;
      }
      // Advance the identity sequence past the loaded ids so new rows don't collide.
      if (hasIdentity) {
        const { rows: mx } = await pg.query<{ m: number }>(
          `SELECT COALESCE(MAX(id), 0)::int m FROM "${table}"`,
        );
        await pg.exec(`ALTER TABLE "${table}" ALTER COLUMN id RESTART WITH ${mx[0].m + 1}`);
      }
    }
  } finally {
    await pg.exec("SET session_replication_role = origin");
  }
  return total;
}
