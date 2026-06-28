// Operator-facing "attach" helper: open a tmux client onto PowderMonkey's private
// socket so you can watch the supervisor server and every live agent by hand.
//
// Everything PM runs lives in tmux on the `powdermonkey` socket (see tmux.ts):
//   pm-server        — the Bun supervisor (web app + API), under a restart loop
//   pm-session-0     — the supervisor's own `claude`
//   pm-session-<id>  — one per local worker session
//
// You can always reach these with raw tmux (`tmux -L powdermonkey attach -t …`),
// but that's a mouthful and you have to know the names. This is the shortcut:
//
//   bun run attach          # attach (see the CLI at the bottom)
//   pm attach               # same, via the bin/pm wrapper
//
// The functions here are also what the UI reads to show the operator the exact
// command to run (it can't open a terminal for them — only point at one).

import { SOCKET, TMUX_BIN, hasSession } from "./tmux.ts";

// The server pane's name (kept in step with supervise.ts via the same env var).
// Attaching here lands on the supervisor console — logs, crashes, restart backoff.
export const DEFAULT_TARGET = process.env.PM_SERVER_SESSION ?? "pm-server";

/** The raw tmux invocation that attaches an interactive client to one PM session. */
export function attachCommand(target: string = DEFAULT_TARGET): string {
  return `${TMUX_BIN} -L ${SOCKET} attach -t ${target}`;
}

/** Run an interactive tmux client onto `target`, inheriting this terminal so it
 *  takes the screen over until the operator detaches (Ctrl-b d). Resolves with the
 *  client's exit code. Returns 1 without attaching if the session isn't live. */
export function attach(target: string = DEFAULT_TARGET): number {
  if (!hasSession(target)) {
    console.error(`no live PowderMonkey session "${target}" on socket "${SOCKET}".`);
    console.error("is the supervisor up? start it with: bun run serve");
    return 1;
  }
  const r = Bun.spawnSync([TMUX_BIN, "-L", SOCKET, "attach", "-t", target], {
    stdio: ["inherit", "inherit", "inherit"],
  });
  return r.exitCode ?? 0;
}

if (import.meta.main) {
  // `bun run attach [target]` — attach to a named session, defaulting to the
  // supervisor server console.
  const target = process.argv[2] ?? DEFAULT_TARGET;
  process.exit(attach(target));
}
