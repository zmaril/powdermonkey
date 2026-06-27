// Launch the supervisor server (this project's Bun process) inside its OWN
// durable tmux session, on the same private `powdermonkey` socket its agents use.
//
// Why: the supervisor owns the plan and the forwarded shells; if it dies with the
// terminal that started it, every attached browser shell goes with it. Running it
// in tmux decouples its lifetime from the launching terminal — you can close the
// terminal, reconnect over ssh, and re-attach to the live server pane at will.
//
//   bun run src/server/supervise.ts          # launch (idempotent) + print attach
//   tmux -L powdermonkey attach -t pm-server  # watch the server's console
//
// Reserved tmux names on the socket: `pm-server` (this), `pm-session-0` (the
// supervisor's own `claude`), `pm-session-<id>` (per-task workers).

import { SOCKET, TMUX_BIN, hasSession, shq, tmux } from "./tmux.ts";

const SHELL = process.env.SHELL || "bash";

// tmux session name for the server pane. Distinct from the `pm-session-*` agent
// sessions so it never collides with a worker id.
export const SERVER_SESSION = process.env.PM_SERVER_SESSION ?? "pm-server";

// The server entrypoint this launcher boots inside the pane.
const SERVER_ENTRY = new URL("./index.ts", import.meta.url).pathname;

function repoDir(): string {
  return process.env.PM_REPO_DIR ?? process.cwd();
}

/** True while the supervisor server's tmux pane is alive. */
export function serverRunning(): boolean {
  return hasSession(SERVER_SESSION);
}

export type LaunchResult =
  | { ok: true; created: boolean; session: string; socket: string }
  | { ok: false; error: string };

/** The command tmux runs inside the server pane. */
function paneCommand(): string {
  return `bun run ${shq(SERVER_ENTRY)}`;
}

/** Idempotently bring up the supervisor server in a detached tmux pane on the
 *  powdermonkey socket. A no-op if it's already running. Returns how to attach. */
export function launchServer(): LaunchResult {
  if (serverRunning()) {
    return { ok: true, created: false, session: SERVER_SESSION, socket: SOCKET };
  }
  // Run under a login shell so PATH/profile resolve `bun`, exec'd so the pane's
  // process IS the server (signals reach it, no stray wrapper shell).
  const cmd = `exec ${SHELL} -l -c ${shq(paneCommand())}`;
  const r = tmux("new-session", "-d", "-s", SERVER_SESSION, "-c", repoDir(), cmd);
  if (!r.ok) {
    return { ok: false, error: r.stderr.trim() || "tmux new-session failed" };
  }
  return { ok: true, created: true, session: SERVER_SESSION, socket: SOCKET };
}

/** Kill the server pane (and the server in it). */
export function stopServer(): boolean {
  if (!serverRunning()) return false;
  return tmux("kill-session", "-t", SERVER_SESSION).ok;
}

if (import.meta.main) {
  const r = launchServer();
  if (!r.ok) {
    console.error(`failed to launch supervisor: ${r.error}`);
    process.exit(1);
  }
  const where = `tmux -L ${r.socket} attach -t ${r.session}`;
  console.log(
    r.created
      ? `supervisor launched in tmux session '${r.session}' (socket '${r.socket}').`
      : `supervisor already running in tmux session '${r.session}' (socket '${r.socket}').`,
  );
  console.log(`attach: ${where}`);
}
