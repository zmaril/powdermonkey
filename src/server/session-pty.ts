import { eq } from "drizzle-orm";
import { db } from "./db.ts";
import { closePty, ptyExited, resizePty, spawnShell, writePty } from "./pty.ts";
import { sessions } from "./schema.ts";

// One long-lived `claude` per local session, run inside tmux so it OUTLIVES the
// supervisor. The supervisor is started with `--watch`; editing PowderMonkey's own
// source (the whole point of self-improvement) restarts it. If the agent were a
// child of the supervisor it would die on every save. Instead each session's
// `claude` lives in a detached tmux session on a private socket; the supervisor
// only ever *attaches* to it.
//
// Clicking "Shell" on a task opens /pty?session=<id>, which attaches to that live
// tmux session (sharing one stream across browser tabs and replaying scrollback).
// Because the agent lives in tmux, the attach reconnects to the SAME running
// `claude` even after a supervisor restart. Silence after output is read as
// "claude is parked at a prompt, waiting for you" and surfaced as `needs_input`.

// biome-ignore lint/suspicious/noExplicitAny: native PTY handle (see pty.ts).
type Pty = any;

// A private tmux socket so we never touch the operator's own tmux server.
const TMUX_BIN = process.env.PM_TMUX ?? "tmux";
const SOCKET = process.env.PM_TMUX_SOCKET ?? "powdermonkey";
const SHELL = process.env.SHELL || "bash";

type Entry = {
  // The supervisor-side `tmux attach` PTY: a view onto the durable session, not
  // the agent itself. Recreated on demand (e.g. after a restart); closing it just
  // detaches — the tmux session and its `claude` live on.
  proc: Pty;
  // Ring of recent output, capped to SCROLLBACK_BYTES, replayed to new attachers.
  chunks: Uint8Array[];
  bytes: number;
  subscribers: Set<(b: Uint8Array) => void>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  needsInput: boolean;
};

// The supervisor's OWN `claude` also lives in a durable tmux session rather than
// as a child of the Bun process, for exactly the reason the per-session agents do:
// `bun run --watch` restarts the supervisor on every source edit, which would kill
// a child PTY and lose the conversation. It uses a reserved id — real sessions get
// positive autoincrement ids, so 0 never collides.
export const SUPERVISOR_ID = 0;

// Startup command for the supervisor's durable session. `--continue` resumes the
// most recent conversation in the repo dir when the tmux session is cold-started
// (first boot, or after a manual `tmux kill-session`); `|| claude` starts fresh
// when there's no prior conversation to resume. Across `--watch` restarts the
// process simply keeps running in tmux, so resume rarely even fires.
const SUPERVISOR_CMD = process.env.PM_SUPERVISOR_CMD ?? "claude --continue || claude";

const SCROLLBACK_BYTES = Number(process.env.PM_SCROLLBACK_BYTES ?? 256 * 1024);
// Quiet stretch after output that we treat as "waiting at a prompt". Heuristic:
// while claude streams a reply it keeps emitting; it goes silent at the prompt.
const IDLE_MS = Number(process.env.PM_SESSION_IDLE_MS ?? 2500);

const registry = new Map<number, Entry>();
// Worktree cwd per session, for fresh-shell context. Lost on restart (the tmux
// session survives regardless — `attach` doesn't need it), so default safely.
const cwdById = new Map<number, string>();

function repoDir(): string {
  return process.env.PM_REPO_DIR ?? process.cwd();
}

function sessionName(id: number): string {
  return `pm-session-${id}`;
}

/** Run a tmux control command on our private socket, synchronously. */
function tmux(...args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = Bun.spawnSync([TMUX_BIN, "-L", SOCKET, ...args]);
  return {
    ok: r.exitCode === 0,
    stdout: r.stdout.toString(),
    stderr: r.stderr.toString(),
  };
}

/** True while the durable tmux session (and thus its agent) is alive. */
export function hasSessionPty(sessionId: number): boolean {
  return tmux("has-session", "-t", sessionName(sessionId)).ok;
}

function shq(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** Persist a needs_input transition. Deduped against the in-memory flag so we
 *  only write on edges, not on every output chunk. */
async function persistNeedsInput(sessionId: number, value: boolean): Promise<void> {
  try {
    await db
      .update(sessions)
      .set({ needsInput: value, updatedAt: new Date() })
      .where(eq(sessions.id, sessionId));
  } catch {}
}

function setNeedsInput(sessionId: number, value: boolean): void {
  const entry = registry.get(sessionId);
  if (!entry || entry.needsInput === value) return;
  entry.needsInput = value;
  void persistNeedsInput(sessionId, value);
}

function armIdle(sessionId: number): void {
  const entry = registry.get(sessionId);
  if (!entry) return;
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => setNeedsInput(sessionId, true), IDLE_MS);
}

function pushChunk(entry: Entry, bytes: Uint8Array): void {
  entry.chunks.push(bytes);
  entry.bytes += bytes.length;
  while (entry.bytes > SCROLLBACK_BYTES && entry.chunks.length > 1) {
    const dropped = entry.chunks.shift();
    if (dropped) entry.bytes -= dropped.length;
  }
}

/** Bring up the durable tmux session running the agent (idempotent per id). The
 *  agent starts immediately, detached, so it's already running before anyone
 *  attaches — and keeps running across supervisor restarts. */
export function startSessionPty(sessionId: number, cwd: string, startup: string): void {
  cwdById.set(sessionId, cwd);
  if (hasSessionPty(sessionId)) return;

  const name = sessionName(sessionId);
  // Run the agent under a login shell (so PATH/profile resolve `claude`), then
  // fall through to an interactive shell when it exits.
  const inner = startup ? `${startup}; exec ${SHELL} -i` : `exec ${SHELL} -i`;
  const cmd = `${SHELL} -l -c ${shq(inner)}`;

  // Follow the most recently active (browser) client's size and drop the status
  // bar. Global, but scoped to our private socket — never the operator's tmux.
  tmux("set-option", "-g", "window-size", "latest");
  tmux("set-option", "-g", "status", "off");
  tmux("new-session", "-d", "-s", name, "-x", "220", "-y", "50", "-c", cwd, cmd);
}

/** Idempotently bring up the supervisor's OWN durable tmux session (reserved id
 *  0), running `claude` in the repo dir. Started on boot and re-ensured whenever
 *  the supervisor shell is attached, so the supervisor's conversation survives
 *  `--watch` restarts exactly like a worker session's does. */
export function startSupervisorPty(): void {
  startSessionPty(SUPERVISOR_ID, repoDir(), SUPERVISOR_CMD);
}

/** Spawn the supervisor-side attach PTY for a live session and register it. */
function createAttachEntry(sessionId: number): Entry {
  const name = sessionName(sessionId);
  const entry: Entry = {
    proc: null,
    chunks: [],
    bytes: 0,
    subscribers: new Set(),
    idleTimer: null,
    needsInput: false,
  };
  registry.set(sessionId, entry);
  // `exec tmux attach` replaces the shell, so when the attach ends (we detach, or
  // the session is killed) the PTY exits cleanly. tmux redraws the current screen
  // on attach, so a freshly-created entry still shows the agent's live state.
  entry.proc = spawnShell(
    cwdById.get(sessionId) ?? repoDir(),
    (bytes) => {
      pushChunk(entry, bytes);
      for (const send of entry.subscribers) {
        try {
          send(bytes);
        } catch {}
      }
      setNeedsInput(sessionId, false);
      armIdle(sessionId);
    },
    `exec ${TMUX_BIN} -L ${SOCKET} attach -t ${name}`,
  );
  armIdle(sessionId);
  ptyExited(entry.proc).then(() => detachSessionPty(sessionId));
  return entry;
}

/** Subscribe to a session's live stream after replaying its scrollback. Lazily
 *  (re)creates the attach PTY if the durable tmux session exists — so this works
 *  the first time, across tabs, and after a supervisor restart. Returns an
 *  unsubscribe fn, or null if no live session exists. */
export function attachSessionPty(
  sessionId: number,
  onData: (b: Uint8Array) => void,
): (() => void) | null {
  let entry = registry.get(sessionId);
  if (!entry) {
    if (!hasSessionPty(sessionId)) return null;
    entry = createAttachEntry(sessionId);
  }
  const e = entry;
  for (const c of e.chunks) {
    try {
      onData(c);
    } catch {}
  }
  e.subscribers.add(onData);
  return () => {
    e.subscribers.delete(onData);
    // Last viewer left: drop the attach PTY so it stops constraining the agent's
    // size. The tmux session (and its agent) keeps running, ready to re-attach.
    if (e.subscribers.size === 0) detachSessionPty(sessionId);
  };
}

export function writeSessionPty(sessionId: number, data: string): void {
  const entry = registry.get(sessionId);
  if (!entry) return;
  writePty(entry.proc, data);
  setNeedsInput(sessionId, false);
  armIdle(sessionId);
}

export function resizeSessionPty(sessionId: number, cols: number, rows: number): void {
  const entry = registry.get(sessionId);
  if (entry) resizePty(entry.proc, cols, rows);
}

/** Detach the supervisor's view without ending the session: close the attach PTY
 *  (tmux client) but leave the tmux session and its agent running. */
function detachSessionPty(sessionId: number): void {
  const entry = registry.get(sessionId);
  if (!entry) return;
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  registry.delete(sessionId);
  try {
    closePty(entry.proc);
  } catch {}
}

/** Tear down a session for good (on land): kill the tmux session and its agent,
 *  and detach our view. */
export function killSessionPty(sessionId: number): void {
  detachSessionPty(sessionId);
  if (hasSessionPty(sessionId)) tmux("kill-session", "-t", sessionName(sessionId));
  cwdById.delete(sessionId);
  void persistNeedsInput(sessionId, false);
}
