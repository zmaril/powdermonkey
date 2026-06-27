import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";

// PGlite is a single-writer embedded Postgres: two processes opening the same
// data dir at once can clobber it — in the worst case a racing second writer
// truncates the store, so a careless restart "empties the DB". The auto-restart
// loop makes that race real: a new server can boot while the old one is still
// tearing down (or a stray `bun run dev` can collide with the tmux pane).
//
// This is a pid lockfile guarding the data dir. Only one *live* process may hold
// it. A restart after a clean exit reclaims the lock (we remove it on exit); a
// stale lock left by a crashed pid is detected (the pid is no longer alive) and
// stolen, so the backoff loop can always recover. A lock held by a *live* writer
// makes acquisition throw — the second writer refuses to open the DB rather than
// risk emptying it.

export class WriterLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WriterLockError";
  }
}

/** The lock path guarding a PGlite data dir (a sibling, never inside the store). */
export function lockPathFor(dataDir: string): string {
  return `${dataDir}.lock`;
}

/** True if a process with this pid currently exists. `kill(pid, 0)` sends no
 *  signal; it just probes — EPERM means alive-but-not-ours, ESRCH means gone. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Read the pid recorded in the lock file, or null if missing/garbage. */
function readHolder(lockPath: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Acquire an exclusive single-writer lock for `dataDir`. Returns a release
 * function (also wired to run on process exit / SIGINT / SIGTERM). Throws
 * WriterLockError if another *live* process already holds the lock.
 */
export function acquireWriterLock(dataDir: string): () => void {
  const lockPath = lockPathFor(dataDir);

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      // O_EXCL: atomic create-or-fail, so two racing writers can't both win.
      const fd = openSync(lockPath, "wx");
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return wireRelease(lockPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const holder = readHolder(lockPath);
      if (holder != null && holder !== process.pid && alive(holder)) {
        throw new WriterLockError(
          `PGlite data dir ${dataDir} is locked by a live writer (pid ${holder}); refusing to open a second writer that could empty the store.`,
        );
      }
      // Stale (the holder pid is gone) or unreadable: steal it and retry.
      try {
        rmSync(lockPath, { force: true });
      } catch {}
    }
  }
  throw new WriterLockError(`could not acquire writer lock ${lockPath} after retries`);
}

/** Register release on exit and return a manual release fn (idempotent). */
function wireRelease(lockPath: string): () => void {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    // Only remove the lock if we still own it, so a steal-race never deletes
    // another process's freshly-acquired lock.
    try {
      if (readHolder(lockPath) === process.pid) rmSync(lockPath, { force: true });
    } catch {}
  };
  process.once("exit", release);
  process.once("SIGINT", () => {
    release();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    release();
    process.exit(143);
  });
  return release;
}
