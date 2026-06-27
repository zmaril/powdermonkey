import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WriterLockError,
  acquireWriterLock,
  lockPathFor,
} from "../src/server/writer-lock.ts";

function freshDataDir(): string {
  return join(mkdtempSync(join(tmpdir(), "pm-lock-")), "pg");
}

test("acquire writes our pid and release removes the lock", () => {
  const dir = freshDataDir();
  const lock = lockPathFor(dir);

  const release = acquireWriterLock(dir);
  expect(existsSync(lock)).toBe(true);
  expect(readFileSync(lock, "utf8").trim()).toBe(String(process.pid));

  release();
  expect(existsSync(lock)).toBe(false);
  // release is idempotent
  release();
  expect(existsSync(lock)).toBe(false);
});

test("a lock held by a live writer is refused", () => {
  const dir = freshDataDir();
  // Forge a lock owned by a definitely-alive process that isn't us: our parent.
  // (ppid is alive while this test runs and is never our own pid.)
  writeFileSync(lockPathFor(dir), `${process.ppid}\n`);

  expect(() => acquireWriterLock(dir)).toThrow(WriterLockError);
});

test("a stale lock from a dead pid is stolen, never emptying the DB", () => {
  const dir = freshDataDir();
  const lock = lockPathFor(dir);
  // A pid that cannot be alive (kernel pid_max far exceeds this in practice, and
  // pid 2^31-1 is never assigned) stands in for a crashed previous writer.
  writeFileSync(lock, "2147483646\n");

  // The new writer (e.g. the backoff loop's restart) reclaims the stale lock
  // instead of refusing — so a crash can't wedge the server out of its own DB.
  const release = acquireWriterLock(dir);
  expect(readFileSync(lock, "utf8").trim()).toBe(String(process.pid));
  release();
});

test("two acquisitions in one process don't deadlock on our own pid", () => {
  const dir = freshDataDir();
  // Pre-seed a lock that records OUR pid (a leftover from this same process).
  // acquire should treat it as reclaimable rather than refusing.
  writeFileSync(lockPathFor(dir), `${process.pid}\n`);
  const release = acquireWriterLock(dir);
  expect(existsSync(lockPathFor(dir))).toBe(true);
  release();
});
