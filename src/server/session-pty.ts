import { eq } from "drizzle-orm";
import { db } from "./db.ts";
import { sshVmSync, vmAttachCmd } from "./exe.ts";
import { closePty, ptyExited, resizePty, spawnShell, writePty } from "./pty.ts";
import { sessions } from "./schema.ts";
import { SOCKET, shq, TMUX_BIN, tmux } from "./tmux.ts";

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
  // Notified once when the durable session ends for good (PTY exited, or it was
  // landed/stopped/killed) — distinct from a viewer merely detaching. Lets the
  // browser swap the dead terminal for an end-state instead of a blank pane.
  endSubscribers: Set<() => void>;
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

// Remote host per session, for `exe` sessions whose durable tmux lives on a
// worker VM rather than this box. Registered at start, and re-registered from
// the session row (kind=exe → its vm) by attach/teardown callers after a
// supervisor restart — with no host registered a session is treated as local.
const hostById = new Map<number, string>();

/** Tell session-pty a session's durable tmux lives on a remote host. Idempotent;
 *  callers that read the session row (attach, land, stop) re-register after a
 *  restart so the in-memory map heals lazily. */
export function registerSessionHost(sessionId: number, host: string): void {
  hostById.set(sessionId, host);
}

function repoDir(): string {
  return process.env.PM_REPO_DIR ?? process.cwd();
}

function sessionName(id: number): string {
  return `pm-session-${id}`;
}

/** Run a tmux control command where this session's durable tmux actually lives:
 *  the local private socket, or — for a session registered to a remote host — the
 *  same-named socket on that VM over ssh. The remote side always uses plain
 *  `tmux` (PM_TMUX points at a supervisor-machine binary, not the VM's). */
function tmuxFor(sessionId: number, ...args: string[]): { ok: boolean } {
  const host = hostById.get(sessionId);
  if (!host) return tmux(...args);
  return sshVmSync(host, `tmux -L ${SOCKET} ${args.map(shq).join(" ")}`);
}

/** True while the durable tmux session (and thus its agent) is alive. */
export function hasSessionPty(sessionId: number): boolean {
  return tmuxFor(sessionId, "has-session", "-t", sessionName(sessionId)).ok;
}

/** Persist a needs_input transition. Deduped against the in-memory flag so we
 *  only write on edges, not on every output chunk. */
async function persistNeedsInput(sessionId: number, value: boolean): Promise<void> {
  try {
    // Writing the sessions row is enough to reach the browser: the /sync feed
    // (app.ts) streams the edge into the sessions collection — which lights up the
    // Active pane and fires the "needs you" notification — without a poll.
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
 *  attaches — and keeps running across supervisor restarts. Pass `host` for an
 *  exe session: the same tmux session is created on that VM instead (where `cwd`
 *  and the startup command are remote-side paths). */
export function startSessionPty(
  sessionId: number,
  cwd: string,
  startup: string,
  host?: string,
): void {
  cwdById.set(sessionId, cwd);
  if (host) registerSessionHost(sessionId, host);
  if (hasSessionPty(sessionId)) return;

  const name = sessionName(sessionId);
  // Run the agent under a login shell (so PATH/profile resolve `claude`), then
  // fall through to an interactive shell when it exits. Remote VMs get a plain
  // `bash` rather than the supervisor's $SHELL — it's a different machine.
  const shell = host ? "bash" : SHELL;
  const inner = startup ? `${startup}; exec ${shell} -i` : `exec ${shell} -i`;
  const cmd = `${shell} -l -c ${shq(inner)}`;

  // Follow the most recently active (browser) client's size and drop the status
  // bar. Global, but scoped to our private socket — never the operator's tmux.
  tmuxFor(sessionId, "set-option", "-g", "window-size", "latest");
  tmuxFor(sessionId, "set-option", "-g", "status", "off");
  tmuxFor(sessionId, "new-session", "-d", "-s", name, "-x", "220", "-y", "50", "-c", cwd, cmd);
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
    endSubscribers: new Set(),
    idleTimer: null,
    needsInput: false,
  };
  registry.set(sessionId, entry);
  // `exec tmux attach` replaces the shell, so when the attach ends (we detach, or
  // the session is killed) the PTY exits cleanly. tmux redraws the current screen
  // on attach, so a freshly-created entry still shows the agent's live state.
  // A remote (exe) session attaches through `ssh -t` to the VM's tmux instead —
  // same PTY plumbing, the child is just ssh; its local cwd is immaterial (and a
  // registered host means cwdById holds a REMOTE path), so it runs from repoDir.
  const host = hostById.get(sessionId);
  const attach = host
    ? vmAttachCmd(host, `tmux -L ${SOCKET} attach -t ${name}`)
    : `exec ${TMUX_BIN} -L ${SOCKET} attach -t ${name}`;
  entry.proc = spawnShell(
    host ? repoDir() : (cwdById.get(sessionId) ?? repoDir()),
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
    attach,
  );
  armIdle(sessionId);
  // The attach PTY exiting while it's still the registered entry means the durable
  // session went away under us (its agent exited, or tmux was killed) — not a
  // viewer leaving (that path deletes the entry first, so the check below fails).
  // Signal end-of-session to any watchers before tearing the attach view down.
  ptyExited(entry.proc).then(() => {
    if (registry.get(sessionId) === entry) {
      notifyEnded(sessionId);
      detachSessionPty(sessionId);
    }
  });
  return entry;
}

/** Fire the end-of-session callbacks for a session's watchers, once. */
function notifyEnded(sessionId: number): void {
  const entry = registry.get(sessionId);
  if (!entry) return;
  for (const onEnd of entry.endSubscribers) {
    try {
      onEnd();
    } catch {}
  }
  entry.endSubscribers.clear();
}

/** Subscribe to a session's live stream after replaying its scrollback. Lazily
 *  (re)creates the attach PTY if the durable tmux session exists — so this works
 *  the first time, across tabs, and after a supervisor restart. `onEnd` (optional)
 *  fires once if the durable session ends while subscribed (so the UI can show an
 *  end-state rather than a dead terminal). Returns an unsubscribe fn, or null if no
 *  live session exists. */
export function attachSessionPty(
  sessionId: number,
  onData: (b: Uint8Array) => void,
  onEnd?: () => void,
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
  if (onEnd) e.endSubscribers.add(onEnd);
  return () => {
    e.subscribers.delete(onData);
    if (onEnd) e.endSubscribers.delete(onEnd);
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
  // Tell watchers the session is ending before we drop the entry — detach alone is
  // silent (it's also the viewer-left path), so an active shell pane would just go
  // blank on land/stop without this.
  notifyEnded(sessionId);
  detachSessionPty(sessionId);
  if (hasSessionPty(sessionId)) tmuxFor(sessionId, "kill-session", "-t", sessionName(sessionId));
  cwdById.delete(sessionId);
  hostById.delete(sessionId);
  void persistNeedsInput(sessionId, false);
}
