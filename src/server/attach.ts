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

import { hasSession, SOCKET, shq, TMUX_BIN, tmux } from "./tmux.ts";

// The server pane's name (kept in step with supervise.ts via the same env var).
// Attaching here lands on the supervisor console — logs, crashes, restart backoff.
export const DEFAULT_TARGET = process.env.PM_SERVER_SESSION ?? "pm-server";

// The dashboard is its own tmux session whose single window tiles one pane per
// live PM session — the server plus every agent — so `pm attach` shows the whole
// machine at once instead of just one console. It's rebuilt on each attach so the
// layout always matches what's running; nothing else uses this name.
export const DASHBOARD_SESSION = process.env.PM_DASHBOARD_SESSION ?? "pm-dashboard";

/** The raw tmux invocation that attaches an interactive client to one PM session. */
export function attachCommand(target: string = DASHBOARD_SESSION): string {
  return `${TMUX_BIN} -L ${SOCKET} attach -t ${target}`;
}

/** Every live PM-managed session on the socket, except the dashboard itself
 *  (it's a viewer, not a thing to view). Empty when the socket has no server. */
export function liveTargets(): string[] {
  const r = tmux("list-sessions", "-F", "#{session_name}");
  if (!r.ok) return [];
  return r.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((n) => n.length > 0 && n !== DASHBOARD_SESSION);
}

/** Order panes for the dashboard: the server first, then the workers by ascending
 *  session id (so the supervisor's own claude, id 0, leads), then any stragglers. */
export function orderTargets(names: string[]): string[] {
  const rank = (n: string): [number, number] => {
    if (n === DEFAULT_TARGET) return [0, 0];
    const m = n.match(/^pm-session-(\d+)$/);
    if (m) return [1, Number(m[1])];
    return [2, 0];
  };
  return [...names].sort((a, b) => {
    const [ga, ia] = rank(a);
    const [gb, ib] = rank(b);
    return ga - gb || ia - ib || a.localeCompare(b);
  });
}

export type DashboardResult = { ok: true; targets: string[] } | { ok: false; error: string };

/** (Re)build the dashboard session: a single tiled window with one pane per live
 *  PM session, each pane a nested tmux client attached to that session. Killed and
 *  rebuilt every call so it reflects the current set; when a session ends its
 *  attach exits and tmux drops the pane. Returns the targets in pane order. */
export function buildDashboard(): DashboardResult {
  const targets = orderTargets(liveTargets());
  if (targets.length === 0) {
    return { ok: false, error: `no live PowderMonkey sessions on socket "${SOCKET}"` };
  }
  if (hasSession(DASHBOARD_SESSION)) tmux("kill-session", "-t", DASHBOARD_SESSION);

  // Each pane just attaches (nested) to one session; `exec` so the pane's process
  // IS the client and the pane closes the moment that session goes away. `env -u
  // TMUX` clears the dashboard's own $TMUX so tmux allows the nested attach (it
  // refuses by default to avoid accidental recursion).
  const pane = (name: string) => `exec env -u TMUX ${TMUX_BIN} -L ${SOCKET} attach -t ${shq(name)}`;
  const created = tmux("new-session", "-d", "-s", DASHBOARD_SESSION, pane(targets[0]));
  if (!created.ok) {
    return { ok: false, error: created.stderr.trim() || "tmux new-session failed" };
  }
  // Split a pane in, then re-tile, for each remaining session. Re-tiling between
  // splits keeps room so later panes don't hit "no space for a new pane".
  for (const name of targets.slice(1)) {
    tmux("split-window", "-t", DASHBOARD_SESSION, pane(name));
    tmux("select-layout", "-t", DASHBOARD_SESSION, "tiled");
  }
  tmux("select-layout", "-t", DASHBOARD_SESSION, "tiled");
  return { ok: true, targets };
}

/** Run an interactive tmux client onto `target`, inheriting this terminal so it
 *  takes the screen over until the operator detaches (Ctrl-b d). Resolves with the
 *  client's exit code. Returns 1 without attaching if the session isn't live. */
export function attachTo(target: string): number {
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

/** Build the dashboard from whatever's running, then attach to it — the default
 *  `pm attach`. Returns the exit code; 1 if there's nothing live to show. */
export function attachDashboard(): number {
  const built = buildDashboard();
  if (!built.ok) {
    console.error(built.error);
    console.error("is the supervisor up? start it with: bun run serve");
    return 1;
  }
  console.error(`PowderMonkey: ${built.targets.length} pane(s) — ${built.targets.join(", ")}`);
  return attachTo(DASHBOARD_SESSION);
}

if (import.meta.main) {
  // `bun run attach`          → build + attach the one-pane-per-session dashboard.
  // `bun run attach <target>` → attach straight to that one named session.
  const target = process.argv[2];
  process.exit(target ? attachTo(target) : attachDashboard());
}
