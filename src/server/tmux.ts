// Shared helpers for talking to PowderMonkey's private tmux server. A dedicated
// socket (`powdermonkey` by default) keeps every PM-managed tmux session — the
// supervisor server, its own `claude`, and per-task worker agents — off the
// operator's own tmux server, so we can create/kill freely without touching it.

export const TMUX_BIN = process.env.PM_TMUX ?? "tmux";
export const SOCKET = process.env.PM_TMUX_SOCKET ?? "powdermonkey";

export type TmuxResult = { ok: boolean; stdout: string; stderr: string };

/** Run a tmux control command on an ARBITRARY socket, synchronously. Used to reach
 *  a tmux server pm doesn't own — e.g. disponent's `-L disponent` socket, where a
 *  local-backend agent lives — while `tmux()` below stays pinned to pm's own. */
export function tmuxOn(socket: string, ...args: string[]): TmuxResult {
  const r = Bun.spawnSync([TMUX_BIN, "-L", socket, ...args]);
  return {
    ok: r.exitCode === 0,
    stdout: r.stdout.toString(),
    stderr: r.stderr.toString(),
  };
}

/** Run a tmux control command on our private socket, synchronously. */
export function tmux(...args: string[]): TmuxResult {
  return tmuxOn(SOCKET, ...args);
}

/** True while a tmux session of the given name is alive on the given socket. */
export function hasSessionOn(socket: string, name: string): boolean {
  return tmuxOn(socket, "has-session", "-t", name).ok;
}

/** True while a tmux session of the given name is alive on our socket. */
export function hasSession(name: string): boolean {
  return hasSessionOn(SOCKET, name);
}

/** Single-quote a string for safe interpolation into a `sh -c` command. */
export function shq(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}
