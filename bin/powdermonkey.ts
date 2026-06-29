#!/usr/bin/env bun
// The PowderMonkey CLI — the operator-facing entrypoint, exposed on PATH as
// `powdermonkey` (npm "bin"). It's the single command for everything:
//
//   powdermonkey serve            # launch the supervisor for the project in the CWD
//   powdermonkey attach           # tmux dashboard: one pane per session + the server
//   powdermonkey attach <target>  # …or attach straight to one named session
//   powdermonkey alias            # optionally install the short `pm` alias
//
// It resolves the package through ESM imports (relative to this file's real
// location), so it works as a symlink on PATH, via bunx, from a checkout, or baked
// into a `bun build --compile` binary — where it is its own runtime and re-execs
// itself for the supervisor loop (the `__server` / `__serve-loop` internal verbs).
//
// The current working directory is the PROJECT being supervised (its data/ lives
// there); PowderMonkey only supplies the code. `attach` doesn't even need the cwd —
// the tmux socket is global per user — so it works from anywhere.

import { symlinkSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { attachDashboard, attachTo } from "../src/server/attach.ts";
import { launchServer, runWithBackoff } from "../src/server/supervise.ts";
import { TMUX_BIN } from "../src/server/tmux.ts";

const USAGE = `powdermonkey — orchestrate cloud Claude Codes for long-term solo dev

usage:
  powdermonkey serve            launch the supervisor (web app + API) in tmux, for
                                the project in the current directory; idempotent
  powdermonkey attach           open the tmux dashboard: one pane per session + server
  powdermonkey attach <target>  attach to one named session (e.g. pm-server, pm-session-7)
  powdermonkey tui              open the text dashboard (the SSH front-end, locally)
  powdermonkey alias [dir]      symlink a short \`pm\` alongside powdermonkey (opt-in)
  powdermonkey --version        print the version

Needs tmux and git on PATH (and, unless you run the compiled binary, bun).`;

/** Fail early with a clear message if tmux is missing — every command needs it,
 *  and the alternative is a cryptic ENOENT from deep inside a helper. */
function ensureTmux(): void {
  const r = Bun.spawnSync([TMUX_BIN, "-V"], { stdio: ["ignore", "ignore", "ignore"] });
  if (!r.success) {
    console.error(`powdermonkey needs tmux on your PATH (looked for "${TMUX_BIN}").`);
    console.error("install it (e.g. `brew install tmux` / `apt install tmux`) and retry.");
    process.exit(127);
  }
}

/** Install a short `pm` alias next to the powdermonkey command. Opt-in: npm only
 *  links `powdermonkey`, so anyone who wants `pm` runs this once. */
function installAlias(dir?: string): number {
  const self = Bun.which("powdermonkey");
  if (!self) {
    console.error("can't find `powdermonkey` on your PATH — install it first, then retry.");
    console.error("(or just add `alias pm=powdermonkey` to your shell rc.)");
    return 1;
  }
  const target = join(dir ?? dirname(self), "pm");
  try {
    try {
      unlinkSync(target);
    } catch {}
    symlinkSync(self, target);
  } catch (e) {
    console.error(`couldn't create ${target}: ${e instanceof Error ? e.message : e}`);
    console.error("pick a writable dir on your PATH: `powdermonkey alias ~/.local/bin`");
    return 1;
  }
  console.log(`linked ${target} -> ${self}  (now \`pm\` works too)`);
  return 0;
}

const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case "attach": {
    ensureTmux();
    const target = rest[0];
    process.exit(target ? attachTo(target) : attachDashboard());
    break;
  }
  case "serve": {
    ensureTmux();
    const r = launchServer();
    if (!r.ok) {
      console.error(`failed to launch supervisor: ${r.error}`);
      process.exit(1);
    }
    console.log(
      r.created
        ? `supervisor launched in tmux session '${r.session}' (socket '${r.socket}').`
        : `supervisor already running in tmux session '${r.session}' (socket '${r.socket}').`,
    );
    console.log("attach: powdermonkey attach");
    process.exit(0);
    break;
  }
  // Internal verbs the supervisor uses to re-invoke itself (see paths.selfArgv):
  //   __serve-loop — the restart loop that owns the server pane (never returns).
  //   __server     — one server run; importing index.ts boots Elysia + listens.
  case "__serve-loop":
    await runWithBackoff();
    break;
  case "__server":
    await import("../src/server/index.ts");
    break;
  // The text dashboard — the same TUI the SSH front-end serves, run locally against
  // a supervisor on $PM_URL (default localhost:4500). Importing it runs it.
  case "tui":
    await import("../src/tui/main.ts");
    break;
  case "alias":
    process.exit(installAlias(rest[0]));
    break;
  case "-v":
  case "--version":
    console.log(pkg.version);
    break;
  case undefined:
  case "-h":
  case "--help":
  case "help":
    console.log(USAGE);
    process.exit(cmd === undefined ? 2 : 0);
    break;
  default:
    console.error(`powdermonkey: unknown command '${cmd}'\n`);
    console.error(USAGE);
    process.exit(2);
}
