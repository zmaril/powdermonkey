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

import { mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pkg from "../package.json" with { type: "json" };
import { attachDashboard, attachTo } from "../src/server/attach.ts";
import type { SqlClient } from "../src/server/backup.ts";
import { IS_COMPILED, PUBLIC_DIR } from "../src/server/paths.ts";
import { launchServer, runWithBackoff } from "../src/server/supervise.ts";
import { TMUX_BIN } from "../src/server/tmux.ts";

const USAGE = `powdermonkey — orchestrate cloud Claude Codes for long-term solo dev

usage:
  powdermonkey serve            launch the supervisor (web app + API) in tmux, for
                                the project in the current directory; idempotent
  powdermonkey attach           open the tmux dashboard: one pane per session + server
  powdermonkey attach <target>  attach to one named session (e.g. pm-server, pm-session-7)
  powdermonkey alias [dir]      symlink a short \`pm\` alongside powdermonkey (opt-in)
  powdermonkey backup [file]    save a version-independent JSON snapshot of the store
                                (from the running supervisor; default data/backups/…)
  powdermonkey backup --branch <name> [--push]
                                export the snapshot to a git branch (optionally push it)
  powdermonkey backup --pr      export the snapshot to a fresh branch and open a PR
  powdermonkey restore <file>   load a snapshot into a fresh store (stop the supervisor
                                first — restore needs the exclusive writer lock)
  powdermonkey restore --branch <name>
  powdermonkey restore --pr <number>
                                restore from a snapshot on a branch / PR instead of a file
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

/** Rebuild the web bundle before the server boots, so a freshly-pulled UI change can
 *  never be masked by a stale public/assets left over from an earlier build — the trap
 *  where `serve` restarts but the browser still shows old code. Every `__server` boot
 *  (fresh launch or serve-loop respawn) rebuilds first. Skipped in a compiled binary:
 *  there is no toolchain or src/web there — the bundle is baked in at build:compile time.
 *  A build failure is logged, not fatal: serving the previous bundle beats no server. */
async function buildWebBundle(): Promise<void> {
  if (IS_COMPILED) return;
  const entry = fileURLToPath(new URL("../src/web/main.tsx", import.meta.url));
  const result = await Bun.build({
    entrypoints: [entry],
    outdir: join(PUBLIC_DIR, "assets"),
    target: "browser",
  });
  if (!result.success) {
    console.error("web bundle build failed — serving the previous bundle:");
    for (const log of result.logs) console.error(String(log));
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
    await buildWebBundle();
    await import("../src/server/index.ts");
    break;
  case "alias":
    process.exit(installAlias(rest[0]));
    break;
  case "backup": {
    // Backups go through the running supervisor — it holds the single writer lock, so a
    // second process can't open the store.
    const base = process.env.PM_URL ?? `http://localhost:${process.env.PORT ?? "4500"}`;

    // `--branch`/`--pr` export the snapshot to git via /backup/export (also needs the
    // supervisor, for the same writer-lock reason).
    if (rest[0] === "--branch" || rest[0] === "--pr") {
      const target = rest[0] === "--pr" ? "pr" : "branch";
      const payload: Record<string, unknown> = { target };
      if (target === "branch") {
        if (!rest[1]) {
          console.error("usage: powdermonkey backup --branch <name> [--push]");
          process.exit(2);
        }
        payload.branch = rest[1];
        payload.push = rest.includes("--push");
      }
      let r: Response;
      try {
        r = await fetch(`${base}/backup/export`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
      } catch {
        console.error(`couldn't reach the supervisor at ${base} — is it running?`);
        process.exit(1);
      }
      const out = (await r.json()) as {
        error?: string;
        rows: number;
        branch: string;
        sha: string;
        pushed: boolean;
        prUrl?: string | null;
      };
      if (!r.ok) {
        console.error(`export failed: ${out.error ?? r.statusText}`);
        process.exit(1);
      }
      if (target === "pr") {
        console.log(
          out.prUrl
            ? `exported ${out.rows} rows → PR ${out.prUrl}`
            : `exported ${out.rows} rows → branch ${out.branch} (pushed; PR not created — check gh auth)`,
        );
      } else {
        console.log(
          `exported ${out.rows} rows → branch ${out.branch}${out.pushed ? " (pushed)" : ""} @ ${out.sha.slice(0, 8)}`,
        );
      }
      process.exit(0);
    }

    // Default: save the /backup response to disk.
    let res: Response;
    try {
      res = await fetch(`${base}/backup`);
    } catch {
      console.error(
        `couldn't reach the supervisor at ${base} — is it running? (powdermonkey serve)`,
      );
      process.exit(1);
    }
    if (!res.ok) {
      console.error(`backup failed: ${res.status} ${res.statusText}`);
      process.exit(1);
    }
    const text = await res.text();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = rest[0] ?? join("data", "backups", `pm-backup-${stamp}.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    const snap = JSON.parse(text) as {
      data: Record<string, unknown[]>;
      meta: { tables: string[] };
    };
    const rows = Object.values(snap.data).reduce((a, v) => a + v.length, 0);
    console.log(`backed up ${rows} rows across ${snap.meta.tables.length} tables → ${file}`);
    process.exit(0);
    break;
  }
  case "restore": {
    // Resolve the snapshot source first — a file (default), a branch, or a PR. This is
    // DB-free (backup-source.ts leans only on git/gh), so we read the source BEFORE
    // opening the store below (opening it takes the writer lock).
    let snap: import("../src/server/backup.ts").Snapshot;
    const src = await import("../src/server/backup-source.ts");
    try {
      if (rest[0] === "--branch") {
        if (!rest[1]) {
          console.error("usage: powdermonkey restore --branch <name>");
          process.exit(2);
        }
        snap = await src.readSnapshotFromBranch({ branch: rest[1] });
      } else if (rest[0] === "--pr") {
        const n = Number(rest[1]);
        if (!Number.isInteger(n) || n <= 0) {
          console.error("usage: powdermonkey restore --pr <number>");
          process.exit(2);
        }
        snap = await src.readSnapshotFromPr(n);
      } else if (rest[0]) {
        snap = src.readSnapshotFromFile(rest[0]);
      } else {
        console.error("usage: powdermonkey restore <file.json> | --branch <name> | --pr <number>");
        process.exit(2);
      }
    } catch (e) {
      console.error(`couldn't read snapshot: ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    }
    // Importing db.ts opens the store and takes the exclusive writer lock — it throws if
    // the supervisor is still up, which is exactly the guard we want.
    let dbmod: typeof import("../src/server/db.ts");
    try {
      dbmod = await import("../src/server/db.ts");
    } catch (e) {
      console.error(`can't open the store: ${e instanceof Error ? e.message : e}`);
      console.error("stop the supervisor first — restore needs the exclusive writer lock.");
      process.exit(1);
    }
    const { restoreSnapshot } = await import("../src/server/backup.ts");
    await dbmod.ready(); // build the schema on the (expected-fresh) store
    try {
      const n = await restoreSnapshot(dbmod.pg as unknown as SqlClient, snap);
      console.log(`restored ${n} rows`);
      process.exit(0);
    } catch (e) {
      console.error(`restore failed: ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    }
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
    console.error(`powdermonkey: unknown command '${cmd}'\n`);
    console.error(USAGE);
    process.exit(2);
}
