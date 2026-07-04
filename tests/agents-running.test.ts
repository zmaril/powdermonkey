import { expect, test } from "bun:test";
import type { Session } from "../src/server/schema.ts";
import { countRunningAgents } from "../src/web/app/agents-running.ts";

// The number the status bar shows: how many agents are running right now. It must
// equal the Sessions pane's Live/"Running" bucket (a live session = an agent running,
// local or remote), so these pin that: live sessions count regardless of their inner
// state (running / waiting / needs-you), and archived ones — landed or stopped — never
// do.

const session = (id: number, over: Partial<Session> = {}): Session =>
  ({
    id,
    kind: "local",
    state: "running",
    needsInput: false,
    archivedAt: null,
    ...over,
  }) as Session;

test("counts every live session, whatever its inner state", () => {
  const sessions = [
    session(1, { state: "running" }),
    session(2, { state: "waiting" }), // parked for Try Again, still a live agent
    session(3, { state: "running", needsInput: true }),
    session(4, { kind: "remote", state: "running" }),
  ];
  expect(countRunningAgents(sessions)).toBe(4);
});

test("excludes archived sessions — landed or stopped is not running", () => {
  const sessions = [
    session(1, { state: "running" }),
    session(2, { state: "idle", archivedAt: new Date("2026-07-01T00:00:00Z") }), // landed
    session(3, { state: "stopped", archivedAt: new Date("2026-07-01T00:00:00Z") }), // aborted
  ];
  expect(countRunningAgents(sessions)).toBe(1);
});

test("no sessions → zero", () => {
  expect(countRunningAgents([])).toBe(0);
});
