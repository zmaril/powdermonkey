#!/usr/bin/env bun
// The PowderMonkey CLI — the operator-facing entrypoint that npm puts on PATH when
// the package is installed globally (`npm i -g powdermonkey`). Exposed under two
// names (see package.json "bin"): `powdermonkey` and the short alias `pm`.
//
//   pm serve            # launch the supervisor for the project in the current dir
//   pm attach           # tmux dashboard: one pane per live session + the server
//   pm attach <target>  # …or attach straight to one named session
//
// It runs the same modules `bun run serve` / `bun run attach` do — but resolved
// through ESM imports (i.e. relative to this file's real location), so it works as
// a symlink on PATH, via `bunx`, or from a checkout alike. A $0/cwd-relative
// launcher would break the moment npm symlinks the bin into a global directory.
//
// The current working directory is the PROJECT being supervised (its data/ lives
// there); the package only supplies the code. `attach` doesn't even need the cwd —
// the tmux socket is global per user — so it works from anywhere.

import { attachDashboard, attachTo } from "../src/server/attach.ts";
import { launchServer } from "../src/server/supervise.ts";
import { TMUX_BIN } from "../src/server/tmux.ts";
import pkg from "../package.json" with { type: "json" };

const USAGE = `powdermonkey — orchestrate cloud Claude Codes for long-term solo dev

usage:
  pm serve            launch the supervisor (web app + API) in tmux, for the
                      project in the current directory; idempotent
  pm attach           open the tmux dashboard: one pane per live session + server
  pm attach <target>  attach to one named session (e.g. pm-server, pm-session-7)
  pm --version        print the version

Both \`pm\` and \`powdermonkey\` invoke this CLI. Needs bun and tmux on PATH.`;

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
    console.log("attach: pm attach");
    process.exit(0);
    break;
  }
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
    console.error(`pm: unknown command '${cmd}'\n`);
    console.error(USAGE);
    process.exit(2);
}
