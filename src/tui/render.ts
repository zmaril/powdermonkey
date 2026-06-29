// Pure terminal rendering: (model + view state) → screen lines. No I/O. Everything
// here returns plain strings carrying ANSI SGR codes; main.ts paints them into the
// alternate screen. Kept pure so render output can be asserted in tests (stripAnsi
// gives the plain text back).

import { type AttachTarget, type Dashboard, TargetKind } from "./model.ts";

// SGR helpers — small enough to inline, named for intent.
const ESC = "\x1b[";
export const reset = `${ESC}0m`;
const sgr =
  (code: string) =>
  (s: string): string =>
    `${ESC}${code}m${s}${reset}`;
export const bold = sgr("1");
export const dim = sgr("2");
export const cyan = sgr("36");
export const yellow = sgr("33");
export const green = sgr("32");
export const red = sgr("31");
export const magenta = sgr("35");
const inverse = sgr("7");

export type View = "plan" | "active" | "notes" | "help";

export type ViewState = {
  view: View;
  // Selection index within the Active list (clamped by main.ts).
  selected: number;
  // Vertical scroll offset for the Plan / Notes bodies.
  scroll: number;
  cols: number;
  rows: number;
  connected: boolean;
  status: string;
};

// Drop SGR codes — used to measure/clamp visible width and to assert plain text.
export function stripAnsi(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes is the point.
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// Pad/truncate to a visible width, ANSI-aware (codes don't count toward width).
function fit(s: string, width: number): string {
  const plain = stripAnsi(s);
  if (plain.length === width) return s;
  if (plain.length < width) return s + " ".repeat(width - plain.length);
  // Truncate: walk the string keeping codes, stop at `width` visible chars.
  let out = "";
  let vis = 0;
  for (let i = 0; i < s.length; ) {
    if (s[i] === "\x1b") {
      // biome-ignore lint/suspicious/noControlCharactersInRegex: matching the ANSI escape is the point.
      const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    if (vis >= width - 1) {
      out += `${dim("…")}`;
      break;
    }
    out += s[i];
    vis++;
    i++;
  }
  return out + reset;
}

// Colorize one line of the plan markdown by its structural prefix. The trailing
// `` `id` `` chips are dimmed so the tree reads cleanly.
function planLine(line: string): string {
  const chip = (s: string) => s.replace(/`([gmtp]\d+)`/g, (_m, id) => dim(`#${id}`));
  if (line.startsWith("# ")) return bold(cyan(chip(line.slice(2))));
  if (line.startsWith("## ")) return bold(chip(line.slice(3)));
  if (line.startsWith("### ")) return yellow(chip(line.slice(4)));
  if (line.startsWith("> ")) return dim(line);
  if (line.startsWith("- [x]")) return green(`  ✓ ${chip(line.slice(6))}`);
  if (line.startsWith("- [ ]")) return dim(`  ○ ${chip(line.slice(6))}`);
  return chip(line);
}

function stateBadge(t: AttachTarget): string {
  if (t.kind === TargetKind.Supervisor) return magenta(TargetKind.Supervisor);
  if (t.needsInput) return red("needs-you");
  if (!t.attachable) return dim("cloud");
  return green(String(t.state));
}

function targetLine(t: AttachTarget, selected: boolean): string {
  const sup = t.kind === TargetKind.Supervisor;
  const tag = sup ? "claude · main" : `${t.kind} · ${t.branch ?? "?"}`;
  const labels = t.taskLabels.length ? t.taskLabels.join(", ") : t.url ? t.url : "—";
  const marker = selected ? cyan("▸ ") : "  ";
  const idCol = sup ? "  0" : String(t.sessionId).padStart(3);
  const body = `${idCol}  ${fit(stateBadge(t), 10)}  ${dim(tag)}  ${labels}`;
  return marker + (selected ? inverse(stripAnsi(body)) : body);
}

function header(model: Dashboard, vs: ViewState): string {
  const dot = vs.connected ? green("●") : red("●");
  const tabs = (["plan", "active", "notes", "help"] as View[])
    .map((v, i) => {
      const label = `${i + 1}:${v}`;
      return v === vs.view ? bold(cyan(label)) : dim(label);
    })
    .join("  ");
  const counts = dim(
    `${model.counts.sessions} live · ${model.counts.needsInput} need-you · ${model.counts.notes} notes`,
  );
  return `${dot} ${bold("PowderMonkey")}   ${tabs}   ${counts}`;
}

function footer(vs: ViewState): string {
  const keys =
    vs.view === "active"
      ? "↑/↓ select · enter attach · s supervisor · r refresh · 1-4 views · q quit"
      : "↑/↓ scroll · r refresh · 1-4 views · q quit";
  const status = vs.status ? `  ${vs.status}` : "";
  return dim(keys) + status;
}

function body(model: Dashboard, vs: ViewState, height: number): string[] {
  const lines: string[] = [];
  if (vs.view === "active") {
    lines.push(dim("  ID  STATE       KIND · BRANCH        WORKING"));
    model.targets.forEach((t, i) => lines.push(targetLine(t, i === vs.selected)));
    if (model.targets.length === 1)
      lines.push(dim("  (no live worker sessions — supervisor only)"));
  } else if (vs.view === "plan") {
    const src = model.planLines.length ? model.planLines : [dim("(no plan loaded)")];
    for (const l of src) lines.push(planLine(l));
  } else if (vs.view === "notes") {
    if (!model.notes.length) lines.push(dim("(no notes)"));
    for (const n of model.notes) {
      lines.push(bold(yellow(n.title || `note ${n.id}`)));
      for (const bl of n.body.split("\n")) lines.push(`  ${bl}`);
      lines.push("");
    }
  } else {
    lines.push(
      bold("PowderMonkey TUI — SSH front-end"),
      "",
      "A text mirror of the web single-pane-of-glass, served over SSH.",
      "",
      `${bold("1")}  Plan    the Goal→Milestone→Task→Phase tree (live)`,
      `${bold("2")}  Active  live sessions; ${bold("enter")} drops into a session's shell`,
      `${bold("3")}  Notes   the operator scratchpad (@notes)`,
      "",
      `${bold("s")}  attach the supervisor's own claude shell`,
      `${bold("r")}  refresh now    ${bold("q")} / Ctrl-C  quit`,
      "",
      dim("Attaching shares the same live tmux session as the web Shell pane —"),
      dim("detach with the usual tmux chord (Ctrl-b d) to come back here."),
    );
  }
  // Apply scroll for the scrollable bodies (plan/notes); active is short.
  const scrolled = vs.view === "active" ? lines : lines.slice(vs.scroll);
  return scrolled.slice(0, height);
}

// A linear, non-interactive dump of the dashboard — used by the SSH `exec` path
// (`ssh host` with a command, or `--snapshot`) where there's no live terminal to
// drive. One coherent glance: live sessions, then the plan tree.
export function renderSnapshot(model: Dashboard): string {
  const out: string[] = [];
  out.push(bold("PowderMonkey"));
  out.push(
    dim(
      `${model.counts.sessions} live session(s) · ${model.counts.needsInput} need-you · ${model.counts.notes} note(s)`,
    ),
  );
  out.push("");
  out.push(bold("Active"));
  for (const t of model.targets) out.push(targetLine(t, false));
  out.push("");
  out.push(bold("Plan"));
  for (const l of model.planLines) out.push(planLine(l));
  return out.join("\n");
}

// Full set of logical screen lines (header + rule + body + footer), each fit to
// the terminal width. main.ts joins these and paints the alternate screen.
export function renderDashboard(model: Dashboard, vs: ViewState): string[] {
  const width = Math.max(20, vs.cols);
  const rule = dim("─".repeat(width));
  const chrome = 4; // header, rule, rule-above-footer, footer
  const bodyHeight = Math.max(1, vs.rows - chrome);
  const lines = [header(model, vs), rule, ...body(model, vs, bodyHeight)];
  // Pad the body region so the footer sits at the bottom.
  while (lines.length < vs.rows - 2) lines.push("");
  lines.push(rule, footer(vs));
  return lines.slice(0, vs.rows).map((l) => fit(l, width));
}
