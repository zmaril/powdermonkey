import { expect, test } from "bun:test";
import type { Session } from "../src/server/schema.ts";
import { needsInputEdges, snapshotNeedsInput } from "../src/web/notifications.ts";

// Notifications fire on the false→true needs_input edge, never on every poll. These
// check the pure edge selector the hook drives: given the previous snapshot and the
// current sessions, only sessions that JUST became needs_input are returned.

const session = (id: number, needsInput: boolean) =>
  ({ id, kind: "local", state: "running", needsInput }) as Session;

test("a session flipping false→true is an edge", () => {
  const prev = snapshotNeedsInput([session(1, false), session(2, false)]);
  const edges = needsInputEdges(prev, [session(1, true), session(2, false)]);
  expect(edges.map((s) => s.id)).toEqual([1]);
});

test("a session already needs_input is not a repeat edge", () => {
  const prev = snapshotNeedsInput([session(1, true)]);
  const edges = needsInputEdges(prev, [session(1, true)]);
  expect(edges).toHaveLength(0);
});

test("clearing needs_input (true→false) is not an edge", () => {
  const prev = snapshotNeedsInput([session(1, true)]);
  const edges = needsInputEdges(prev, [session(1, false)]);
  expect(edges).toHaveLength(0);
});

test("a brand-new session that arrives needing input is an edge", () => {
  const prev = snapshotNeedsInput([session(1, false)]);
  const edges = needsInputEdges(prev, [session(1, false), session(2, true)]);
  expect(edges.map((s) => s.id)).toEqual([2]);
});

test("an unknown session (absent from prev) counts only when it needs input", () => {
  const prev = new Map<number, boolean>();
  const edges = needsInputEdges(prev, [session(5, false), session(6, true)]);
  expect(edges.map((s) => s.id)).toEqual([6]);
});
