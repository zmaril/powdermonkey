import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PM_DATA_DIR = join(mkdtempSync(join(tmpdir(), "pm-")), "pg");
// Isolate the tmux socket so we never create/kill sessions on the operator's
// shared "powdermonkey" socket (these ids start at 1 and could collide).
process.env.PM_TMUX_SOCKET = `pm-test-${process.pid}`;
// A short idle window so the test doesn't sit around; we don't assert on it.
process.env.PM_SESSION_IDLE_MS = "100";

const { ready } = await import("../src/server/db.ts");
const { startSessionPty, attachSessionPty, killSessionPty, hasSessionPty } = await import(
  "../src/server/session-pty.ts"
);

await ready();

const repoDir = mkdtempSync(join(tmpdir(), "pm-repo-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Bring up a durable plain-shell session and wait until it's live. */
async function liveSession(id: number): Promise<void> {
  startSessionPty(id, repoDir, "");
  for (let i = 0; i < 50 && !hasSessionPty(id); i++) await sleep(50);
  expect(hasSessionPty(id)).toBe(true);
}

test("killSessionPty fires the end callback so the UI can show an end-state", async () => {
  const id = 9001;
  await liveSession(id);

  let ended = false;
  const detach = attachSessionPty(
    id,
    () => {},
    () => {
      ended = true;
    },
  );
  expect(detach).not.toBeNull();

  killSessionPty(id);
  expect(ended).toBe(true);
  expect(hasSessionPty(id)).toBe(false);
});

test("a viewer detaching does NOT fire the end callback — the session lives on", async () => {
  const id = 9002;
  await liveSession(id);

  let ended = false;
  const detach = attachSessionPty(
    id,
    () => {},
    () => {
      ended = true;
    },
  );
  expect(detach).not.toBeNull();

  // Last viewer leaves: the attach view is dropped but the session keeps running,
  // so this is NOT an end-of-session — onEnd must stay silent.
  detach?.();
  await sleep(50);
  expect(ended).toBe(false);
  expect(hasSessionPty(id)).toBe(true);

  killSessionPty(id);
});

test("attaching to a session with no live PTY returns null", () => {
  expect(
    attachSessionPty(
      9999,
      () => {},
      () => {},
    ),
  ).toBeNull();
});
