// A pseudo-terminal running a login shell, using Bun's native PTY (Bun ≥ 1.3.5).
// Output arrives via the `data` callback; input/resize/teardown go through
// `proc.terminal`. No node-pty, no native build step.
//
// @types/bun doesn't describe the `terminal` option yet, so the spawn options and
// the `proc.terminal` handle are cast. The runtime shape is verified: data(_t, d)
// streams output, proc.terminal.{write,resize,close} drive it.

// biome-ignore lint/suspicious/noExplicitAny: native PTY API not in @types/bun yet.
type Pty = any;

const SHELL = process.env.SHELL || "bash";
// Default startup command for the supervisor shell. Set PM_SHELL_CMD="" for a
// plain shell. Worker (worktree) shells pass startup="" explicitly — only the
// supervisor shell drops into Claude. Either way we fall through to an
// interactive shell when the startup command exits.
const STARTUP_CMD = process.env.PM_SHELL_CMD ?? "claude";

export function spawnShell(
  cwd: string,
  onData: (bytes: Uint8Array) => void,
  startup: string = STARTUP_CMD,
): Pty {
  const launch = startup ? `${startup}; exec ${SHELL} -i` : `exec ${SHELL} -i`;
  // The `terminal` option isn't in @types/bun yet, so the options bag is cast.
  const options = {
    cwd,
    env: { ...process.env, TERM: "xterm-256color" },
    terminal: {
      cols: 80,
      rows: 24,
      data(_term: unknown, d: unknown) {
        onData(typeof d === "string" ? new TextEncoder().encode(d) : (d as Uint8Array));
      },
    },
    // biome-ignore lint/suspicious/noExplicitAny: native PTY option not typed yet.
  } as any;
  // Login shell so PATH/profile are set (claude is found), then run the startup
  // command and fall through to an interactive shell.
  return Bun.spawn([SHELL, "-l", "-c", launch], options);
}

// Spawn an arbitrary command in a PTY (no login shell wrapper, no fall-through to
// an interactive shell): the command IS the session, so when it exits the PTY
// closes. Used by the SSH front-end to run the TUI directly as the connection's
// program — same native-PTY plumbing as spawnShell, just without the shell scaffold.
export function spawnPty(
  argv: string[],
  opts: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    cols?: number;
    rows?: number;
    onData: (bytes: Uint8Array) => void;
  },
): Pty {
  const options = {
    cwd: opts.cwd,
    env: { TERM: "xterm-256color", ...process.env, ...opts.env },
    terminal: {
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      data(_term: unknown, d: unknown) {
        opts.onData(typeof d === "string" ? new TextEncoder().encode(d) : (d as Uint8Array));
      },
    },
    // biome-ignore lint/suspicious/noExplicitAny: native PTY option not typed yet.
  } as any;
  return Bun.spawn(argv, options);
}

export function writePty(proc: Pty, data: string): void {
  proc.terminal?.write(data);
}

export function resizePty(proc: Pty, cols: number, rows: number): void {
  proc.terminal?.resize(cols, rows);
}

export function closePty(proc: Pty): void {
  try {
    proc.terminal?.close();
  } catch {}
  try {
    proc.kill();
  } catch {}
}

// biome-ignore lint/suspicious/noExplicitAny: see Pty note.
export function ptyExited(proc: Pty): Promise<any> {
  return proc.exited;
}
