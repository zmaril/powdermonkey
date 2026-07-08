import { expect, test } from "bun:test";
import { slugForSession } from "../src/web/terminal-repo.ts";

// The terminal's repo context resolves session → task → repoId → slug. This pins that
// rule (and every way it can come up empty) so a bare #123 links to the right repo in a
// multi-repo workspace.

const links = [
  { sessionId: 10, taskId: 100 },
  { sessionId: 11, taskId: 101 },
];
const tasks = [
  { id: 100, repoId: 1 },
  { id: 101, repoId: 2 },
  { id: 102, repoId: null },
];
const repos = [
  { id: 1, slug: "zmaril/powdermonkey" },
  { id: 2, slug: "acme/widgets" },
];

test("resolves a session to its task's repo slug", () => {
  expect(slugForSession(10, links, tasks, repos)).toBe("zmaril/powdermonkey");
  expect(slugForSession(11, links, tasks, repos)).toBe("acme/widgets");
});

test("undefined when the terminal has no session", () => {
  expect(slugForSession(undefined, links, tasks, repos)).toBeUndefined();
});

test("undefined when nothing links the session (not synced / fresh cwd shell)", () => {
  expect(slugForSession(99, links, tasks, repos)).toBeUndefined();
});

test("undefined when the task pins no repo", () => {
  const linked = [{ sessionId: 12, taskId: 102 }];
  expect(slugForSession(12, linked, tasks, repos)).toBeUndefined();
});

test("undefined when the task's repo isn't in the snapshot yet", () => {
  const t = [{ id: 100, repoId: 7 }];
  expect(slugForSession(10, links, t, repos)).toBeUndefined();
});
