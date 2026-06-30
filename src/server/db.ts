import { mkdirSync, readFileSync } from "node:fs";
import { PGlite, type PGliteOptions } from "@electric-sql/pglite";
import { type PGliteWithLive, live } from "@electric-sql/pglite/live";
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

// The `live` extension installs per-table AFTER INSERT/UPDATE/DELETE triggers that
// pg_notify on change, and re-runs registered live queries when they fire. Because
// the triggers live in the DB, they observe EVERY write — through drizzle or raw
// SQL — so the /sync route (app.ts) streams row deltas to the browser's TanStack DB
// collections without any mutation site remembering to announce itself.
const client = new PGlite(DATA_DIR, { ...pgliteOpts, extensions: { live } });
export const db = drizzle(client, { schema });

/** The raw PGlite client, with the `live` namespace. The change feed uses it to
 *  register live queries; everything else should go through `db` (Drizzle). The
 *  constructor doesn't thread the extension namespaces into its return type, so we
 *  assert the `live`-augmented shape — the runtime instance does carry `.live`. */
export const pg = client as unknown as PGliteWithLive;

let migrated = false;

/** Apply migrations once at boot. Safe to call repeatedly. */
export async function ready(): Promise<void> {
  // Single-process footgun guard. db.ts opens PGlite ONCE at import, on the DATA_DIR it
  // read then; PGlite is single-writer per process. Each DB-backed test file sets its own
  // temp PM_DATA_DIR at its top — which only isolates them if files run in SEPARATE
  // processes. If PM_DATA_DIR has changed since import, multiple such files were loaded
  // into ONE process (bare `bun test` / `bun test tests/`) and would silently share the
  // first file's DB and corrupt each other. Fail loudly with the fix instead.
  if (process.env.PM_DATA_DIR && process.env.PM_DATA_DIR !== DATA_DIR) {
    throw new Error(
      "Multiple DB-backed test files were loaded into ONE process (PGlite is single-writer " +
        "per process, so they'd share one DB). Run `bun run test` — it runs each file in its " +
        "own process. For a single file: `bun test tests/<name>.test.ts`.",
    );
  }
  if (migrated) return;
  // Resolved against the package, not the cwd: a global install supervises a
  // foreign project, where a "drizzle" relative path wouldn't exist.
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  migrated = true;
}
