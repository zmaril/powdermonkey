// SSH front-end to the supervisor — a spike. `ssh -p 4522 localhost` drops you into
// the PowderMonkey TUI (src/tui), a text mirror of the web single-pane-of-glass,
// from which you can watch the plan and attach straight into live agent shells. It
// runs alongside the web app in the same Bun process; the goal is to see how far
// Bun + ssh2 + our existing tmux/PTY backend get us toward "ssh in and it feels like
// the frontend".
//
// This is the TRANSPORT half. It owns: a persisted host key, accepting connections,
// and bridging an SSH channel to a PTY running the TUI (interactive shell) or a
// one-shot snapshot (exec). It deliberately knows nothing about the dashboard — the
// TUI is a normal terminal program spawned in a PTY, exactly like the web Shell pane
// spawns a shell. tmux attach happens *inside* that PTY, so live sessions are shared
// with the browser with zero extra plumbing.
//
// Security: per design.md this is single-operator, no auth, no security model. The
// server binds loopback by default and accepts any credential. Don't expose the port.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AuthContext,
  type Connection,
  type PseudoTtyInfo,
  Server,
  type ServerChannel,
  type Session,
  type WindowChangeInfo,
  utils,
} from "ssh2";
import { closePty, resizePty, spawnPty, writePty } from "./pty.ts";

const PORT = Number(process.env.PM_SSH_PORT ?? 4522);
// Loopback by default — single-operator, no auth. Override only behind a tunnel.
const HOST = process.env.PM_SSH_HOST ?? "127.0.0.1";

// biome-ignore lint/suspicious/noExplicitAny: native PTY handle (see pty.ts).
type Pty = any;
// Just the PTY geometry/term we carry from the `pty` request into `shell`.
type PtyReq = { term?: string; cols?: number; rows?: number };

function repoDir(): string {
  return process.env.PM_REPO_DIR ?? process.cwd();
}

// The TUI script, run as its own Bun process in the PTY. `bun <file>` works in dev
// and from a global install; the compiled binary doesn't ship the TUI as a separate
// file, so SSH is dev/checkout-only for now (the spike target).
const TUI_ENTRY = fileURLToPath(new URL("../tui/main.ts", import.meta.url));

/** Load the persisted SSH host key, generating + storing one on first run. Kept
 *  next to the PGlite store under data/, mode 0600. An ed25519 key is small and
 *  generated without ssh-keygen via ssh2's utils. */
function hostKey(): string {
  const path = join(repoDir(), "data", "ssh_host_ed25519");
  if (existsSync(path)) return readFileSync(path, "utf8");
  mkdirSync(dirname(path), { recursive: true });
  const { private: priv } = utils.generateKeyPairSync("ed25519");
  writeFileSync(path, priv, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {}
  return priv;
}

/** Bridge an interactive SSH shell to a PTY running the TUI. Returns the PTY so the
 *  session's window-change handler can resize it. */
function bridgeShell(stream: ServerChannel, pty: PtyReq): Pty {
  const env = { ...process.env, TERM: pty.term || "xterm-256color" };
  const proc = spawnPty([process.execPath, TUI_ENTRY], {
    cwd: repoDir(),
    env,
    cols: pty.cols,
    rows: pty.rows,
    onData: (bytes) => {
      try {
        stream.write(Buffer.from(bytes));
      } catch {}
    },
  });
  // Client → PTY input.
  stream.on("data", (d: Buffer) => writePty(proc, d.toString("binary")));
  // TUI exited (operator pressed q): close the channel with its code.
  proc.exited.then((code: number) => {
    try {
      stream.exit(typeof code === "number" ? code : 0);
    } catch {}
    try {
      stream.end();
    } catch {}
  });
  // Client hung up: kill the TUI (and the PTY).
  stream.on("close", () => closePty(proc));
  return proc;
}

/** Non-interactive `exec`: run the TUI's snapshot dump and exit. No PTY geometry to
 *  track, so nothing to resize. */
function runExec(stream: ServerChannel): void {
  const proc = spawnPty([process.execPath, TUI_ENTRY, "--snapshot"], {
    cwd: repoDir(),
    cols: 100,
    rows: 60,
    onData: (bytes) => {
      try {
        stream.write(Buffer.from(bytes));
      } catch {}
    },
  });
  proc.exited.then((code: number) => {
    try {
      stream.exit(typeof code === "number" ? code : 0);
    } catch {}
    try {
      stream.end();
    } catch {}
  });
  stream.on("close", () => closePty(proc));
}

let server: Server | null = null;

/** Start the SSH front-end. Idempotent; opt out with PM_SSH=0. Never throws — a
 *  bind failure (port taken) is logged, not fatal, so it can't take the web app
 *  down with it. */
export function startSshServer(): void {
  if (process.env.PM_SSH === "0") return;
  if (server) return;
  let key: string;
  try {
    key = hostKey();
  } catch (e) {
    console.warn("ssh: could not load/generate host key —", e instanceof Error ? e.message : e);
    return;
  }

  const srv = new Server({ hostKeys: [key] }, (client: Connection) => {
    client.on("authentication", (ctx: AuthContext) => {
      // No security model (design.md): accept any method, any user.
      ctx.accept();
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session: Session = accept();
        let pty: PtyReq = {};
        let proc: Pty = null;
        session.on("pty", (a, _r, info: PseudoTtyInfo & { term?: string }) => {
          // ssh2 emits `term` on the pty request; @types/ssh2 omits it, so widen here.
          pty = { term: info.term, cols: info.cols, rows: info.rows };
          a?.();
        });
        session.on("window-change", (a, _r, info: WindowChangeInfo) => {
          pty.cols = info.cols;
          pty.rows = info.rows;
          if (proc && info.cols && info.rows) resizePty(proc, info.cols, info.rows);
          a?.();
        });
        session.on("shell", (a) => {
          proc = bridgeShell(a(), pty);
        });
        session.on("exec", (a) => runExec(a()));
      });
    });
    client.on("error", () => {});
  });

  srv.on("error", (e: NodeJS.ErrnoException) => {
    console.warn(`ssh: server error (${e.code ?? e.message ?? "unknown"}) — front-end disabled`);
  });
  srv.listen(PORT, HOST, () => {
    server = srv;
    console.log(`ssh front-end listening on ${HOST}:${PORT}  (ssh -p ${PORT} ${HOST})`);
  });
}
