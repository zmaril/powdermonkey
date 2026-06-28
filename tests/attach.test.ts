import { afterAll, expect, test } from "bun:test";

// Isolate the tmux socket so nothing here touches the operator's real
// `powdermonkey` server (the helper lists/kills sessions on whatever socket it
// reads at import). A unique name per test process keeps parallel suites apart.
process.env.PM_TMUX_SOCKET = `pm-test-${process.pid}`;

const { attachCommand, attachTo, buildDashboard, orderTargets, liveTargets, DASHBOARD_SESSION } =
  await import("../src/server/attach.ts");
const { tmux } = await import("../src/server/tmux.ts");

// Stand up a fake session on the isolated socket, running a do-nothing shell.
function fakeSession(name: string): void {
  tmux("new-session", "-d", "-s", name, "sh -c 'while :; do sleep 1; done'");
}

afterAll(() => {
  // One shot: tear down the whole private socket (server + every fake session).
  tmux("kill-server");
});

test("attachCommand targets the private socket and the given session", () => {
  expect(attachCommand("pm-server")).toBe(
    `tmux -L ${process.env.PM_TMUX_SOCKET} attach -t pm-server`,
  );
  // Defaults to the dashboard session.
  expect(attachCommand()).toBe(attachCommand(DASHBOARD_SESSION));
});

test("orderTargets puts the server first, then workers by ascending id", () => {
  const ordered = orderTargets(["pm-session-3", "pm-session-0", "pm-server", "pm-session-10"]);
  expect(ordered).toEqual(["pm-server", "pm-session-0", "pm-session-3", "pm-session-10"]);
});

test("attachTo refuses (exit 1) when the target session isn't live", () => {
  // Nothing is running on this throwaway socket yet, so there's nothing to attach to.
  expect(attachTo("pm-server")).toBe(1);
});

test("buildDashboard tiles one pane per live PM session, server first", () => {
  fakeSession("pm-server");
  fakeSession("pm-session-3");
  fakeSession("pm-session-0");

  // liveTargets sees the three sessions (but never the dashboard it builds).
  expect(orderTargets(liveTargets())).toEqual(["pm-server", "pm-session-0", "pm-session-3"]);

  const built = buildDashboard();
  if (!built.ok) throw new Error(built.error);
  expect(built.targets).toEqual(["pm-server", "pm-session-0", "pm-session-3"]);

  // The dashboard session exists with exactly one pane per target.
  const panes = tmux("list-panes", "-t", DASHBOARD_SESSION);
  expect(panes.ok).toBe(true);
  expect(panes.stdout.trim().split("\n")).toHaveLength(3);

  // Rebuilt cleanly on a second call (kills the prior dashboard, same result).
  const again = buildDashboard();
  if (!again.ok) throw new Error(again.error);
  expect(again.targets).toEqual(["pm-server", "pm-session-0", "pm-session-3"]);
});

test("buildDashboard fails cleanly when nothing is live", () => {
  tmux("kill-server"); // wipe the socket
  const built = buildDashboard();
  expect(built.ok).toBe(false);
});
