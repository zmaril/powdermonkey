// Pure shaping of the API snapshot into the dashboard view-model. No I/O, no ANSI
// — just data → data, so it's straightforward to unit-test. render.ts turns the
// model into screen text; main.ts wires fetch → model → render → terminal.

import { SessionKind, SessionState } from "../shared/types.ts";
import type { Snapshot } from "./api.ts";

// tmux session naming mirrors session-pty.ts: each local session's durable agent
// lives in `pm-session-<id>` on the private socket, and the supervisor's own
// `claude` is the reserved id 0. The TUI attaches by execing `tmux attach -t` these
// names, so it must agree with the server on the convention.
export const SUPERVISOR_ID = 0;
export function tmuxName(id: number): string {
  return `pm-session-${id}`;
}

// The display category of an attach row — a superset of SessionKind with the
// synthetic supervisor entry. Its own small vocabulary (SessionKind has no
// supervisor), so it lives here rather than in shared/types.ts.
export const TargetKind = { Supervisor: "supervisor", Local: "local", Remote: "remote" } as const; // lint-allow-string: this IS the display-category enum declaration
export type TargetKind = (typeof TargetKind)[keyof typeof TargetKind];

// The supervisor's synthetic runtime state — it has no sessions row, so it's never
// one of the real SessionState values.
const LIVE = "live"; // lint-allow-string: synthetic supervisor state, not a SessionState

// One attachable target in the Active list: a live session (or the supervisor),
// with the human label and the tmux target the TUI will attach to on Enter.
export type AttachTarget = {
  sessionId: number;
  tmuxTarget: string;
  kind: TargetKind;
  state: SessionState | typeof LIVE;
  needsInput: boolean;
  branch: string | null;
  // Titles of the tasks this session is working (empty for the supervisor).
  taskLabels: string[];
  // A remote (cloud) session has no local tmux to attach to — surfaced but not
  // attachable; the TUI shows its URL instead.
  attachable: boolean;
  url: string | null;
};

export type Dashboard = {
  planLines: string[];
  targets: AttachTarget[];
  notes: { id: number; title: string; body: string }[];
  counts: { sessions: number; needsInput: number; notes: number };
};

// Is this a session we'd surface as "live" in the Active list? Mirrors the web
// Active pane: running or waiting, not archived.
function isLive(state: SessionState, archivedAt: unknown): boolean {
  if (archivedAt) return false;
  return state === SessionState.Running || state === SessionState.Waiting;
}

export function buildDashboard(snap: Snapshot): Dashboard {
  const taskTitle = new Map(snap.tasks.map((t) => [t.id, t.title]));
  // session id → task titles it's linked to (via the session_tasks join).
  const labelsBySession = new Map<number, string[]>();
  for (const link of snap.sessionTasks) {
    const title = taskTitle.get(link.taskId);
    if (!title) continue;
    const arr = labelsBySession.get(link.sessionId) ?? [];
    arr.push(title);
    labelsBySession.set(link.sessionId, arr);
  }

  // The supervisor is always present and always attachable (its tmux session is
  // re-ensured on demand), so it leads the list — the SSH equivalent of the web
  // app's default "supervisor" shell pane.
  const targets: AttachTarget[] = [
    {
      sessionId: SUPERVISOR_ID,
      tmuxTarget: tmuxName(SUPERVISOR_ID),
      kind: TargetKind.Supervisor,
      state: LIVE,
      needsInput: false,
      branch: "main",
      taskLabels: [],
      attachable: true,
      url: null,
    },
  ];

  for (const s of snap.sessions) {
    if (!isLive(s.state, s.archivedAt)) continue;
    const remote = s.kind === SessionKind.Remote;
    targets.push({
      sessionId: s.id,
      tmuxTarget: tmuxName(s.id),
      kind: remote ? TargetKind.Remote : TargetKind.Local,
      state: s.state,
      needsInput: s.needsInput,
      branch: s.branch,
      taskLabels: labelsBySession.get(s.id) ?? [],
      // Only local sessions have a tmux PTY to drop into; a cloud run is shown
      // with its URL but can't be attached from here.
      attachable: !remote,
      url: s.url,
    });
  }

  const planLines = snap.planMarkdown.replace(/\n+$/, "").split("\n");
  const notes = snap.notes.map((n) => ({ id: n.id, title: n.title, body: n.body }));
  const needsInput = targets.filter((t) => t.needsInput).length;

  return {
    planLines,
    targets,
    notes,
    counts: { sessions: targets.length - 1, needsInput, notes: notes.length },
  };
}
