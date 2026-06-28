import { mkdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { type PGliteWithLive, live } from "@electric-sql/pglite/live";
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

// The `live` extension installs per-table AFTER INSERT/UPDATE/DELETE triggers that
// pg_notify on change, and re-runs registered live queries when they fire. Because
// the triggers live in the DB, they observe EVERY write — through drizzle or raw
// SQL — so the realtime change feed (see realtime.ts) can watch the tables directly
// instead of every mutation site remembering to announce itself.
const client = new PGlite(DATA_DIR, { extensions: { live } });
export const db = drizzle(client, { schema });

/** The raw PGlite client, with the `live` namespace. The change feed uses it to
 *  register live queries; everything else should go through `db` (Drizzle). The
 *  constructor doesn't thread the extension namespaces into its return type, so we
 *  assert the `live`-augmented shape — the runtime instance does carry `.live`. */
export const pg = client as unknown as PGliteWithLive;

let migrated = false;

/** Apply migrations once at boot. Safe to call repeatedly. */
export async function ready(): Promise<void> {
  if (migrated) return;
  await migrate(db, { migrationsFolder: "drizzle" });
  migrated = true;
}
