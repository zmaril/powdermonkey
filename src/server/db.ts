import { mkdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "./schema.ts";
import { acquireWriterLock } from "./writer-lock.ts";

// Local PGlite store, owned by the supervisor and persisted under data/pgdata/.
// Source of truth for the *desired* plan; merged PRs on main are the source of
// truth for what's actually complete.
const DATA_DIR = process.env.PM_DATA_DIR ?? "data/pgdata";

// PGlite's NodeFS does a non-recursive mkdir of the store dir, so its parent
// must already exist. Create the full path ourselves to work on a clean checkout.
mkdirSync(DATA_DIR, { recursive: true });

// PGlite is single-writer: take an exclusive lock on the data dir before opening
// it, so a restart (the backoff loop racing the dying process) or a stray second
// server can't open a second writer and clobber the store. Throws if a live
// writer already holds it — better a loud refusal than a silently emptied DB.
acquireWriterLock(DATA_DIR);

const client = new PGlite(DATA_DIR);
export const db = drizzle(client, { schema });

let migrated = false;

/** Apply migrations once at boot. Safe to call repeatedly. */
export async function ready(): Promise<void> {
  if (migrated) return;
  await migrate(db, { migrationsFolder: "drizzle" });
  migrated = true;
}
