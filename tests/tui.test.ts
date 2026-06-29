import { expect, test } from "bun:test";
import type { Note, Session, SessionTask, Task } from "../src/server/schema.ts";
import type { Snapshot } from "../src/tui/api.ts";
import { SUPERVISOR_ID, buildDashboard, tmuxName } from "../src/tui/model.ts";
import { type ViewState, renderDashboard, renderSnapshot, stripAnsi } from "../src/tui/render.ts";

// The TUI is the SSH front-end's view layer. model.ts shapes the API snapshot into
// the dashboard (which sessions are attachable, what each is working); render.ts
// turns that into screen text. Both are pure, so they test without a terminal —
// stripAnsi gives the plain text back for assertions.

const session = (id: number, over: Partial<Session> = {}): Session =>
  ({
    id,
    kind: "local",
    state: "running",
    needsInput: false,
    branch: `pm/task-${id}`,
    archivedAt: null,
    ...over,
  }) as Session;
const link = (sessionId: number, taskId: number): SessionTask =>
  ({ sessionId, taskId }) as SessionTask;
const task = (id: number, title: string): Task =>
  ({ id, milestoneId: 1, title, status: "pending" }) as Task;

function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    planMarkdown:
      "# Goal `g1`\n## Milestone `m1`\n### Task `t1`\n- [x] done `p1`\n- [ ] todo `p2`\n",
    sessions: [],
    sessionTasks: [],
    tasks: [],
    notes: [],
    ...over,
  };
}

const view = (over: Partial<ViewState> = {}): ViewState => ({
  view: "active",
  selected: 0,
  scroll: 0,
  cols: 100,
  rows: 24,
  connected: true,
  status: "",
  ...over,
});

test("tmux names mirror session-pty: supervisor is reserved id 0", () => {
  expect(tmuxName(SUPERVISOR_ID)).toBe("pm-session-0");
  expect(tmuxName(7)).toBe("pm-session-7");
});

test("buildDashboard always leads with an attachable supervisor target", () => {
  const d = buildDashboard(snap());
  expect(d.targets[0].kind).toBe("supervisor");
  expect(d.targets[0].sessionId).toBe(SUPERVISOR_ID);
  expect(d.targets[0].attachable).toBe(true);
  // The supervisor doesn't count toward the "live worker sessions" tally.
  expect(d.counts.sessions).toBe(0);
});

test("buildDashboard surfaces live local sessions with their task labels", () => {
  const d = buildDashboard(
    snap({
      sessions: [session(5)],
      sessionTasks: [link(5, 10), link(5, 11)],
      tasks: [task(10, "wire ssh"), task(11, "build tui")],
    }),
  );
  const t = d.targets.find((x) => x.sessionId === 5);
  expect(t?.attachable).toBe(true);
  expect(t?.tmuxTarget).toBe("pm-session-5");
  expect(t?.taskLabels).toEqual(["wire ssh", "build tui"]);
  expect(d.counts.sessions).toBe(1);
});

test("buildDashboard excludes archived and idle/stopped sessions", () => {
  const d = buildDashboard(
    snap({
      sessions: [
        session(1, { archivedAt: new Date() }),
        session(2, { state: "idle" }),
        session(3, { state: "stopped" }),
        session(4, { state: "waiting" }),
      ],
    }),
  );
  const ids = d.targets.map((t) => t.sessionId);
  expect(ids).toContain(4); // waiting is live
  expect(ids).not.toContain(1);
  expect(ids).not.toContain(2);
  expect(ids).not.toContain(3);
});

test("buildDashboard marks remote (cloud) sessions un-attachable but surfaced", () => {
  const d = buildDashboard(
    snap({ sessions: [session(8, { kind: "remote", url: "https://claude.ai/x", branch: null })] }),
  );
  const t = d.targets.find((x) => x.sessionId === 8);
  expect(t?.kind).toBe("remote");
  expect(t?.attachable).toBe(false);
  expect(t?.url).toBe("https://claude.ai/x");
});

test("needsInput sessions are counted for the need-you tally", () => {
  const d = buildDashboard(snap({ sessions: [session(5, { needsInput: true })] }));
  expect(d.counts.needsInput).toBe(1);
});

test("renderSnapshot dumps live sessions then the plan tree as plain text", () => {
  const d = buildDashboard(
    snap({ sessions: [session(5)], sessionTasks: [link(5, 10)], tasks: [task(10, "wire ssh")] }),
  );
  const text = stripAnsi(renderSnapshot(d));
  expect(text).toContain("PowderMonkey");
  expect(text).toContain("supervisor");
  expect(text).toContain("wire ssh");
  // plan tree carries through, with checkboxes rendered as marks
  expect(text).toContain("Goal");
  expect(text).toContain("✓ done");
  expect(text).toContain("○ todo");
});

test("renderDashboard paints a full screen of exactly `rows` width-`cols` lines", () => {
  const d = buildDashboard(snap());
  const lines = renderDashboard(d, view({ rows: 24, cols: 80 }));
  expect(lines.length).toBe(24);
  for (const l of lines) expect(stripAnsi(l).length).toBe(80);
  // header names the app and the selected tab is reflected in the footer hints
  expect(stripAnsi(lines[0])).toContain("PowderMonkey");
  expect(stripAnsi(lines[lines.length - 1])).toContain("enter attach");
});

test("renderDashboard plan view shows the tree and notes view shows notes", () => {
  const d = buildDashboard(
    snap({ notes: [{ id: 1, title: "scratch", body: "remember the milk" } as Note] }),
  );
  const plan = stripAnsi(renderDashboard(d, view({ view: "plan" })).join("\n"));
  expect(plan).toContain("Goal");
  const notes = stripAnsi(renderDashboard(d, view({ view: "notes" })).join("\n"));
  expect(notes).toContain("scratch");
  expect(notes).toContain("remember the milk");
});
