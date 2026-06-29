// The TUI runtime: fetch → model → render → terminal, plus key handling and the
// "attach into a session's tmux shell" gesture that makes this feel like the web
// app's Shell pane. Runs as its own process — spawned in a PTY per SSH connection
// (see server/ssh.ts), or locally via `powdermonkey tui`. Two modes:
//
//   --snapshot   print one linear dashboard dump and exit (the SSH `exec` path,
//                e.g. `ssh -p 4522 host status`). No raw mode, no alt screen.
//   (default)    the interactive full-screen dashboard.

import { type Snapshot, fetchSnapshot } from "./api.ts";
import { type Dashboard, SUPERVISOR_ID, buildDashboard, tmuxName } from "./model.ts";
import { type View, type ViewState, renderDashboard, renderSnapshot } from "./render.ts";

const TMUX_BIN = process.env.PM_TMUX ?? "tmux";
const SOCKET = process.env.PM_TMUX_SOCKET ?? "powdermonkey";
const POLL_MS = Number(process.env.PM_TUI_POLL_MS ?? 2000);

// ── snapshot mode ─────────────────────────────────────────────────────────────
async function snapshot(): Promise<void> {
  try {
    const snap = await fetchSnapshot();
    process.stdout.write(`${renderSnapshot(buildDashboard(snap))}\n`);
  } catch (e) {
    process.stdout.write(`PowderMonkey: supervisor unreachable (${(e as Error).message})\n`);
    process.exitCode = 1;
  }
}

// ── interactive mode ────────────────────────────────────────────────────────────
const ALT_ON = "\x1b[?1049h\x1b[?25l";
const ALT_OFF = "\x1b[?25h\x1b[?1049l";
const HOME = "\x1b[H";
const CLEAR = "\x1b[2J";

class Tui {
  private model: Dashboard = {
    planLines: [],
    targets: [],
    notes: [],
    counts: { sessions: 0, needsInput: 0, notes: 0 },
  };
  private vs: ViewState = {
    view: "active",
    selected: 0,
    scroll: 0,
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
    connected: false,
    status: "connecting…",
  };
  private poll: ReturnType<typeof setInterval> | null = null;
  private fetching = false;
  // True while the current `status` line is a connection banner (so a successful
  // poll clears it without stomping a deliberate message like an attach hint).
  private statusIsConn = true;
  // While attached to a tmux child the render loop is suspended.
  private attached = false;
  private done = false;

  async start(): Promise<void> {
    process.stdout.write(ALT_ON);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (b: Buffer) => this.onInput(b));
    process.on("SIGWINCH", () => this.onResize());
    process.on("SIGINT", () => this.quit());
    await this.refresh();
    this.paint();
    this.poll = setInterval(() => void this.refresh(), POLL_MS);
    // Resolve only when the user quits, so the spawning process (ssh.ts / the CLI)
    // can await the whole session.
    await new Promise<void>((resolve) => {
      this.resolve = resolve;
    });
  }

  private resolve: (() => void) | null = null;

  private async refresh(): Promise<void> {
    if (this.fetching || this.attached || this.done) return;
    this.fetching = true;
    try {
      const snap: Snapshot = await fetchSnapshot();
      this.model = buildDashboard(snap);
      this.vs.connected = true;
      // A successful poll clears a connection banner, but leaves a deliberate
      // message (e.g. an attach hint) alone.
      if (this.statusIsConn) {
        this.vs.status = "";
        this.statusIsConn = false;
      }
      this.clampSelection();
    } catch (e) {
      this.vs.connected = false;
      this.vs.status = `supervisor unreachable (${(e as Error).message})`;
      this.statusIsConn = true;
    } finally {
      this.fetching = false;
      if (!this.attached) this.paint();
    }
  }

  private clampSelection(): void {
    const max = Math.max(0, this.model.targets.length - 1);
    if (this.vs.selected > max) this.vs.selected = max;
    if (this.vs.selected < 0) this.vs.selected = 0;
  }

  private onResize(): void {
    this.vs.cols = process.stdout.columns || 80;
    this.vs.rows = process.stdout.rows || 24;
    if (!this.attached) this.paint();
  }

  private paint(): void {
    if (this.attached || this.done) return;
    const lines = renderDashboard(this.model, this.vs);
    process.stdout.write(HOME + CLEAR + lines.join("\r\n"));
  }

  private setView(v: View): void {
    this.vs.view = v;
    this.vs.scroll = 0;
    this.paint();
  }

  private moveSelection(delta: number): void {
    if (this.vs.view === "active") {
      this.vs.selected += delta;
      this.clampSelection();
    } else {
      this.vs.scroll = Math.max(0, this.vs.scroll + delta);
    }
    this.paint();
  }

  private onInput(b: Buffer): void {
    const s = b.toString("utf8");
    // Arrow keys arrive as ESC [ A/B; handle before treating ESC as a key.
    if (s === "\x1b[A") {
      this.moveSelection(-1);
      return;
    }
    if (s === "\x1b[B") {
      this.moveSelection(1);
      return;
    }
    for (const ch of s) {
      if (ch === "\x03" || ch === "q") {
        this.quit();
        return;
      }
      if (ch === "1") this.setView("plan");
      else if (ch === "2") this.setView("active");
      else if (ch === "3") this.setView("notes");
      else if (ch === "4" || ch === "?" || ch === "h") this.setView("help");
      else if (ch === "r") void this.refresh();
      else if (ch === "k") this.moveSelection(-1);
      else if (ch === "j") this.moveSelection(1);
      else if (ch === "s") void this.attach(SUPERVISOR_ID, tmuxName(SUPERVISOR_ID));
      else if (ch === "\r" || ch === "\n") this.enter();
    }
  }

  private enter(): void {
    if (this.vs.view !== "active") return;
    const t = this.model.targets[this.vs.selected];
    if (!t) return;
    if (!t.attachable) {
      this.vs.status = t.url ? `cloud session — open ${t.url}` : "not attachable from here";
      this.statusIsConn = false;
      this.paint();
      return;
    }
    void this.attach(t.sessionId, t.tmuxTarget);
  }

  // Drop into a session's live tmux shell — the same durable `claude` the web Shell
  // pane attaches to. We suspend the render loop, hand the whole terminal to a
  // `tmux attach` child (stdio inherited through our PTY), and resume the dashboard
  // when it detaches (Ctrl-b d) or the session ends.
  private async attach(_sessionId: number, name: string): Promise<void> {
    if (this.attached) return;
    this.attached = true;
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write(ALT_OFF);
    const proc = Bun.spawn([TMUX_BIN, "-L", SOCKET, "attach", "-t", name], {
      stdio: ["inherit", "inherit", "inherit"],
    });
    const code = await proc.exited;
    this.attached = false;
    if (this.done) return;
    process.stdout.write(ALT_ON);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    this.vs.status = code === 0 ? "" : `no live session '${name}' (it may have ended)`;
    this.statusIsConn = false;
    await this.refresh();
    this.paint();
  }

  private quit(): void {
    if (this.done) return;
    this.done = true;
    if (this.poll) clearInterval(this.poll);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write(ALT_OFF);
    this.resolve?.();
  }
}

// Entry. `--snapshot` (or any arg) → one-shot dump; otherwise the live dashboard.
if (process.argv.includes("--snapshot")) {
  await snapshot();
} else {
  await new Tui().start();
}
