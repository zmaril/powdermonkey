import { afterAll } from "bun:test";

// PGlite 0.5.4 exits the process with code 99 if a client is left open at exit. DB-backed
// test files open db.ts's module-level client on a throwaway PM_DATA_DIR and never close it
// (the server never exits, so leaving it open is inert in production). Close it after each
// test file so the process exits cleanly. Loaded via `bun test --preload` (see package.json).
//
// Guarded to a temp PM_DATA_DIR: if a file didn't set one (a non-db test), or points at the
// real store, we do nothing — this must never touch the live DB or acquire its writer lock.
afterAll(async () => {
  const dir = process.env.PM_DATA_DIR;
  if (!dir || dir === "data/pgdata") return;
  try {
    const { pg } = await import("../src/server/db.ts");
    await pg.close();
  } catch {}
});
