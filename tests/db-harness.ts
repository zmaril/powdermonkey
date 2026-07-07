// Shared setup for DB-backed tests. Each test file runs in its own process
// (see `bun run test`), and PGlite is single-writer per process, so every file
// isolates its own database in a fresh temp dir.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A fresh temp directory, e.g. `tmp("pm-repo-")`. */
export function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Point PGlite at a fresh temp dir for this test file, then import and return the
 * `db` module. `db.ts` reads PM_DATA_DIR at import time, so call this BEFORE
 * importing anything else from `src/server` (set other scratch env vars — via
 * `tmp()` — first). Register `await ready()` in your own `beforeAll` as before.
 */
export function setupTestDb(): Promise<typeof import("../src/server/db.ts")> {
  process.env.PM_DATA_DIR = join(tmp("pm-"), "pg");
  return import("../src/server/db.ts");
}
