import { describe, expect, test } from "bun:test";
import { wordHost } from "../examples/word-host.ts";
import { powdermonkey } from "../src/host/powdermonkey.ts";
import {
  available,
  canTransition,
  decide,
  dispatch,
  type Entity,
  History,
  isTerminal,
  unitIndices,
} from "../src/nervo/index.ts";

// Nervo is exercised against BOTH hosts through the same engine — the executable proof
// that the core is domain-agnostic. If any assertion below leaned on a PowderMonkey
// concept, the Word host couldn't satisfy it.

describe("fsm engine", () => {
  test("canTransition and isTerminal read the host's transition map", () => {
    const task = powdermonkey.entities.task;
    expect(canTransition(task, "pending", "dispatched")).toBe(true);
    expect(canTransition(task, "pending", "merged")).toBe(false);
    expect(isTerminal(powdermonkey.entities.session, "idle")).toBe(true);
    expect(isTerminal(powdermonkey.entities.session, "running")).toBe(false);
  });
});

describe("command bus — PowderMonkey host", () => {
  const task = (state: string): Entity => ({ kind: "task", id: 7, state });

  test("dispatch on a pending task transitions it and prices the cost", () => {
    const r = dispatch(powdermonkey, task("pending"), "dispatch");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tx.before.state).toBe("pending");
    expect(r.tx.after.state).toBe("dispatched");
    expect(r.tx.cost).toEqual({ unit: "cloud-run", amount: 1 });
  });

  test("the permission spec refuses dispatch on a merged task", () => {
    const r = dispatch(powdermonkey, task("merged"), "dispatch");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/pending/);
  });

  test("an action against the wrong entity kind is refused", () => {
    const phase: Entity = { kind: "phase", id: 1, state: "todo" };
    const r = dispatch(powdermonkey, phase, "dispatch");
    expect(r.ok).toBe(false);
  });

  test("available lists only the moves permitted from the current state", () => {
    expect(available(powdermonkey, task("pending")).sort()).toEqual(
      ["cancel", "dispatch", "start-local"].sort(),
    );
    expect(available(powdermonkey, task("merged"))).toEqual(["reopen"]);
  });
});

describe("command bus — Word host (same engine, different domain)", () => {
  const doc = (state: string): Entity => ({ kind: "document", id: 1, state });

  test("submit-for-review drives draft → in-review with its own cost unit", () => {
    const r = dispatch(wordHost, doc("draft"), "submit-for-review");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tx.after.state).toBe("in-review");
    expect(r.tx.cost).toEqual({ unit: "review-round", amount: 1 });
  });

  test("publish is refused on a draft (must be reviewed first)", () => {
    const r = dispatch(wordHost, doc("draft"), "publish");
    expect(r.ok).toBe(false);
  });

  test("available reflects the document lifecycle", () => {
    expect(available(wordHost, doc("in-review")).sort()).toEqual(["publish", "send-back"].sort());
  });
});

describe("history — undo/redo over transactions", () => {
  test("undo returns the transaction whose before-state the caller restores", () => {
    const history = new History();
    const start: Entity = { kind: "task", id: 7, state: "pending" };

    const r = dispatch(powdermonkey, start, "dispatch");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    history.record(r.tx);

    expect(history.canUndo()).toBe(true);
    expect(history.entries).toHaveLength(1);

    const undone = history.undo();
    expect(undone?.before.state).toBe("pending");
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(true);

    const redone = history.redo();
    expect(redone?.after.state).toBe("dispatched");
  });
});

describe("proposals — create-subtree grouping", () => {
  const changes = [
    { op: "add" as const, kind: "section", ref: "s1", fields: {} },
    { op: "add" as const, kind: "paragraph", parentRef: "s1", fields: {} },
    { op: "add" as const, kind: "paragraph", parentRef: "s1", fields: {} },
    { op: "edit" as const, kind: "document", id: 1, fields: {} },
  ];

  test("a subtree add groups its children into one decidable unit", () => {
    expect([...unitIndices(changes, 0)].sort()).toEqual([0, 1, 2]);
    expect([...unitIndices(changes, 3)]).toEqual([3]); // the edit is a singleton
  });

  test("accepting the subtree leaves only the edit; the caller applies the unit", () => {
    const { unit, remaining, done } = decide(changes, 0, true);
    expect(unit).toHaveLength(3);
    expect(remaining).toEqual([changes[3]]);
    expect(done).toBe(false);
  });

  test("rejecting a unit drops it and applies nothing", () => {
    const { unit, remaining } = decide(changes, 0, false);
    expect(unit).toEqual([]);
    expect(remaining).toEqual([changes[3]]);
  });
});
