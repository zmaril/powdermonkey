// Connection layer: an embedded Postgres (PGlite) via Drizzle. Opens the DB,
// applies migrations at boot, and hands out the typed `db` handle. The live
// entity tables are the source of truth (see repo.ts); moving to a real Postgres
// later is just swapping the client here for `drizzle-orm/node-postgres`.

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "./schema.ts";

const ROOT = resolve(import.meta.dir, "../..");

let _db: PgliteDatabase<typeof schema> | null = null;

export async function initDb(): Promise<void> {
  // Read at call time so tests can set PM_DB_DIR (incl. "memory://") first.
  const dataDir = process.env.PM_DB_DIR ?? resolve(ROOT, "data/pgdata");
  if (!dataDir.startsWith("memory")) mkdirSync(dataDir, { recursive: true }); // PGlite's own mkdir isn't recursive
  const client = new PGlite(dataDir);
  _db = drizzle(client, { schema });
  await migrate(_db, { migrationsFolder: resolve(ROOT, "drizzle") });
}

export function db(): PgliteDatabase<typeof schema> {
  if (!_db) throw new Error("initDb() has not been called");
  return _db;
}

export { ROOT };
