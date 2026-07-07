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
// Inside the pane the server runs under an auto-restart loop (`--loop`): if it
// crashes it's brought straight back up, backing off exponentially so a crash
// loop doesn't spin hot, and resetting once a run has stayed healthy.
//
// Reserved tmux names on the socket: `pm-server` (this), `pm-session-0` (the
// supervisor's own `claude`), `pm-session-<id>` (per-task workers).

import { selfArgv } from "./paths.ts";
import { hasSession, SOCKET, shq, tmux } from "./tmux.ts";

const SHELL = process.env.SHELL || "bash";

// tmux session name for the server pane. Distinct from the `pm-session-*` agent
// sessions so it never collides with a worker id.
export const SERVER_SESSION = process.env.PM_SERVER_SESSION ?? "pm-server";

// Backoff bounds for the auto-restart loop. After a crash we wait `backoff` and
// double it (capped at MAX); a run that stays up at least HEALTHY_MS is treated
// as a good boot and resets the backoff to MIN.
const BACKOFF_MIN_MS = Number(process.env.PM_BACKOFF_MIN_MS ?? 1000);
const BACKOFF_MAX_MS = Number(process.env.PM_BACKOFF_MAX_MS ?? 30_000);
const HEALTHY_MS = Number(process.env.PM_HEALTHY_MS ?? 60_000);

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

/** The command tmux runs inside the server pane: re-invoke ourselves in restart-loop
 *  mode. `selfArgv` points at the compiled binary (no bun needed) or `bun <cli>` in
 *  dev, so the pane survives as its own runtime either way. */
function paneCommand(): string {
  return selfArgv("__serve-loop").map(shq).join(" ");
}

/** Spawn one server run by re-invoking ourselves in `__server` mode. Stdio is
 *  inherited so its console lands in the pane. */
function spawnServer(): Bun.Subprocess {
  return Bun.spawn(selfArgv("__server"), {
    cwd: repoDir(),
    env: process.env,
    stdio: ["inherit", "inherit", "inherit"],
  });
}

/** Run the server once, resolving with its exit code when the process exits. */
export function runServerOnce(): Promise<number> {
  return spawnServer().exited;
}

/** Supervise the server forever: restart on every exit, backing off
 *  exponentially after a crash and resetting once a run has stayed healthy.
 *  Runs in the foreground — this is what the tmux pane executes. */
export async function runWithBackoff(): Promise<never> {
  // Forward termination to the running child so `tmux kill-session` / Ctrl-C
  // stops the server AND ends the loop, instead of orphaning either.
  let child: Bun.Subprocess | null = null;
  const stop = (exitCode: number) => () => {
    try {
      child?.kill();
    } catch {}
    process.exit(exitCode);
  };
  process.on("SIGINT", stop(130));
  process.on("SIGTERM", stop(143));

  let backoff = BACKOFF_MIN_MS;
  for (;;) {
    const startedAt = Date.now();
    child = spawnServer();
    const code = await child.exited;
    child = null;
    const uptimeMs = Date.now() - startedAt;
    // A run that stayed up long enough was a real boot, not a crash loop: reset.
    if (uptimeMs >= HEALTHY_MS) backoff = BACKOFF_MIN_MS;
    console.error(
      `[supervise] server exited (code ${code}) after ${Math.round(uptimeMs / 1000)}s; ` +
        `restarting in ${Math.round(backoff / 1000)}s`,
    );
    await Bun.sleep(backoff);
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
  }
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

// No CLI of its own: the `powdermonkey` entrypoint (bin/powdermonkey.ts) drives the
// lifecycle — `serve` calls launchServer(), the `__serve-loop` it spawns calls
// runWithBackoff(), and each `__server` it spawns boots the actual server (index.ts).
