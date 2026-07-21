import { existsSync } from "node:fs";
import { eq } from "drizzle-orm";
import { db } from "./db.ts";
import { connectHolder, type HolderClient } from "./holder-client.ts";
import { closePty, ptyExited, resizePty, spawnShell, writePty } from "./pty.ts";
import { sessions } from "./schema.ts";
import { hasSession, hasSessionOn, SOCKET, shq, TMUX_BIN, tmux } from "./tmux.ts";

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
  // detaches — the tmux session and its `claude` live on. Null for a holder-backed
  // entry, whose byte source/sink is `holder` (below) instead of a Bun PTY.
  proc: Pty;
  // M2b: a live attach to a disponent pty-holder's unix socket, used INSTEAD of a
  // `tmux attach` Bun PTY when the session is holder-backed (flag-gated). Only the
  // byte source/sink differs — the ring, subscribers, and idle timer are shared.
  // Null for the tmux path.
  holder: HolderClient | null;
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

function repoDir(): string {
  return process.env.PM_REPO_DIR ?? process.cwd();
}

function sessionName(id: number): string {
  return `pm-session-${id}`;
}

/** Where a tmux attach points: a socket + a session name. pm's own worker sessions
 *  live on our private socket (`SOCKET`) as `pm-session-<id>`; a session dispatched
 *  through disponent's local tmux backend instead lives in disponent's own tmux (its
 *  `-L <endpoint>` socket + `dsp-<uid>`, from #78's transport-neutral descriptor), so
 *  the attach target carries that and the browser terminal reaches the REAL agent. */
export type AttachTarget = { socket: string; tmuxSession: string };

/** pm's own durable session for an id, on pm's private socket — the default target. */
function pmTarget(id: number): AttachTarget {
  return { socket: SOCKET, tmuxSession: sessionName(id) };
}

/** True while the durable tmux session (and thus its agent) is alive. */
export function hasSessionPty(sessionId: number): boolean {
  return hasSession(sessionName(sessionId));
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

/** A fresh, empty attach Entry, registered under `sessionId`. Shared by the tmux
 *  and holder create paths — only the byte source they wire up afterward differs. */
function newEntry(sessionId: number): Entry {
  const entry: Entry = {
    proc: null,
    holder: null,
    chunks: [],
    bytes: 0,
    subscribers: new Set(),
    endSubscribers: new Set(),
    idleTimer: null,
    needsInput: false,
  };
  registry.set(sessionId, entry);
  return entry;
}

/** Fan one pty chunk out: ring it for scrollback, push to every live subscriber,
 *  then mark the session busy + re-arm its idle timer. The onData body both create
 *  paths (tmux PTY, holder socket) share. */
function broadcast(sessionId: number, entry: Entry, bytes: Uint8Array): void {
  pushChunk(entry, bytes);
  for (const send of entry.subscribers) {
    try {
      send(bytes);
    } catch {}
  }
  setNeedsInput(sessionId, false);
  armIdle(sessionId);
}

/** Replay `entry`'s scrollback to a new subscriber, register it, and return the
 *  unsubscribe fn that drops the attach once the last viewer leaves. Shared by the
 *  tmux and holder attach paths — the entry's origin is immaterial here. */
function subscribeToEntry(
  sessionId: number,
  entry: Entry,
  onData: (b: Uint8Array) => void,
  onEnd?: () => void,
): () => void {
  for (const c of entry.chunks) {
    try {
      onData(c);
    } catch {}
  }
  entry.subscribers.add(onData);
  if (onEnd) entry.endSubscribers.add(onEnd);
  return () => {
    entry.subscribers.delete(onData);
    if (onEnd) entry.endSubscribers.delete(onEnd);
    // Last viewer left: drop the attach so it stops constraining the agent. The
    // durable session (tmux or holder) and its agent keep running, ready to re-attach.
    if (entry.subscribers.size === 0) detachSessionPty(sessionId);
  };
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
  tmux("set-option", "-g", "status", "off"); // lint-allow-string: tmux option value, not SyncMode.Off
  tmux("new-session", "-d", "-s", name, "-x", "220", "-y", "50", "-c", cwd, cmd);
}

/** Idempotently bring up the supervisor's OWN durable tmux session (reserved id
 *  0), running `claude` in the repo dir. Started on boot and re-ensured whenever
 *  the supervisor shell is attached, so the supervisor's conversation survives
 *  `--watch` restarts exactly like a worker session's does. */
export function startSupervisorPty(): void {
  startSessionPty(SUPERVISOR_ID, repoDir(), SUPERVISOR_CMD);
}

/** Spawn the supervisor-side attach PTY for a live session and register it. The
 *  `target` says which tmux (socket + session) to attach to — pm's own by default,
 *  or disponent's for a disponent-local session (from #78's descriptor). */
function createAttachEntry(sessionId: number, target: AttachTarget): Entry {
  const entry = newEntry(sessionId);
  // `exec tmux attach` replaces the shell, so when the attach ends (we detach, or
  // the session is killed) the PTY exits cleanly. tmux redraws the current screen
  // on attach, so a freshly-created entry still shows the agent's live state.
  entry.proc = spawnShell(
    cwdById.get(sessionId) ?? repoDir(),
    (bytes) => broadcast(sessionId, entry, bytes),
    `exec ${TMUX_BIN} -L ${target.socket} attach -t ${target.tmuxSession}`,
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
 *  live session exists. `target` overrides which tmux to attach to (default: pm's own
 *  `pm-session-<id>` on pm's socket); a disponent-local session passes disponent's
 *  socket + `dsp-<uid>` (from #78's descriptor) so the terminal reaches the real agent. */
export function attachSessionPty(
  sessionId: number,
  onData: (b: Uint8Array) => void,
  onEnd?: () => void,
  target?: AttachTarget,
): (() => void) | null {
  let entry = registry.get(sessionId);
  if (!entry) {
    const tgt = target ?? pmTarget(sessionId);
    if (!hasSessionOn(tgt.socket, tgt.tmuxSession)) return null;
    entry = createAttachEntry(sessionId, tgt);
  }
  return subscribeToEntry(sessionId, entry, onData, onEnd);
}

/** Create a holder-backed attach entry: dial the disponent pty-holder's unix socket
 *  (M2b) and register it, wiring its byte stream into the SAME Entry the tmux path
 *  uses (scrollback ring, subscribers, idle timer). Returns null if the socket is
 *  gone or the dial fails, so the caller can fall back. The holder replays scrollback
 *  on connect, so a freshly-created entry still shows the agent's live state. */
async function createHolderAttachEntry(
  sessionId: number,
  socketPath: string,
): Promise<Entry | null> {
  if (!existsSync(socketPath)) return null;
  const entry = newEntry(sessionId);
  // The holder ending (child Exit) — or the socket dropping without one (holder
  // gone) — means the durable session went away under us, exactly like the tmux
  // attach PTY exiting. The guard distinguishes it from a viewer detaching: detach
  // deletes the entry first, so `registry.get` no longer matches and we stay silent.
  const onGone = () => {
    if (registry.get(sessionId) === entry) {
      notifyEnded(sessionId);
      detachSessionPty(sessionId);
    }
  };
  let client: HolderClient;
  try {
    client = await connectHolder(socketPath, {
      onData: (bytes) => broadcast(sessionId, entry, bytes),
      onExit: onGone,
      onClose: onGone,
    });
  } catch {
    registry.delete(sessionId);
    return null;
  }
  entry.holder = client;
  armIdle(sessionId);
  return entry;
}

/** Subscribe to a holder-backed session's live stream (M2b) after replaying its
 *  scrollback — the holder-socket counterpart of {@link attachSessionPty}. Lazily
 *  dials the holder on first attach, then shares the stream across tabs. Returns an
 *  unsubscribe fn, or null if the holder socket isn't there (dial failed). */
export async function attachHolderSessionPty(
  sessionId: number,
  socketPath: string,
  onData: (b: Uint8Array) => void,
  onEnd?: () => void,
): Promise<(() => void) | null> {
  let entry = registry.get(sessionId);
  if (!entry) {
    const created = await createHolderAttachEntry(sessionId, socketPath);
    if (!created) return null;
    entry = created;
  }
  return subscribeToEntry(sessionId, entry, onData, onEnd);
}

export function writeSessionPty(sessionId: number, data: string): void {
  const entry = registry.get(sessionId);
  if (!entry) return;
  // Holder-backed entries route input to the holder socket (an Input frame); tmux
  // entries write the Bun PTY. Either way the idle timer re-arms below.
  if (entry.holder) entry.holder.write(data);
  else writePty(entry.proc, data);
  setNeedsInput(sessionId, false);
  armIdle(sessionId);
}

export function resizeSessionPty(sessionId: number, cols: number, rows: number): void {
  const entry = registry.get(sessionId);
  if (!entry) return;
  if (entry.holder) entry.holder.resize(cols, rows);
  else resizePty(entry.proc, cols, rows);
}

/** Detach the supervisor's view without ending the session: close the attach PTY
 *  (tmux client) but leave the tmux session and its agent running. */
function detachSessionPty(sessionId: number): void {
  const entry = registry.get(sessionId);
  if (!entry) return;
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  registry.delete(sessionId);
  try {
    // A holder entry detaches by closing its socket (a Detach frame); the held
    // session lives on. A tmux entry closes its attach PTY. Deleting the entry
    // above first means any resulting close callback sees no registered entry and
    // won't misfire the end-of-session path.
    if (entry.holder) entry.holder.close();
    else closePty(entry.proc);
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
  if (hasSessionPty(sessionId)) tmux("kill-session", "-t", sessionName(sessionId));
  cwdById.delete(sessionId);
  void persistNeedsInput(sessionId, false);
}
