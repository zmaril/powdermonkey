import { mkdirSync, readFileSync } from "node:fs";
import { PGlite, type PGliteOptions } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { IS_COMPILED, MIGRATIONS_DIR, PG_DATA, PG_WASM } from "./paths.ts";
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

// In a compiled binary, PGlite's own attempt to load its WASM module + filesystem
// image resolves into bun's virtual fs and fails (the bytes aren't embedded). Hand
// it the sidecar copies we ship beside the executable instead. In dev this is empty
// and PGlite loads its own from node_modules. Both reads are synchronous so the
// module's `db` export stays eager.
const pgliteOpts: PGliteOptions = IS_COMPILED
  ? {
      wasmModule: new WebAssembly.Module(readFileSync(PG_WASM)),
      fsBundle: new Blob([readFileSync(PG_DATA)]),
    }
  : {};

const client = new PGlite(DATA_DIR, pgliteOpts);
export const db = drizzle(client, { schema });

let migrated = false;

/** Apply migrations once at boot. Safe to call repeatedly. */
export async function ready(): Promise<void> {
  if (migrated) return;
  // Resolved against the package, not the cwd: a global install supervises a
  // foreign project, where a "drizzle" relative path wouldn't exist.
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  migrated = true;
}
