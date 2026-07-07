import { expect, test } from "bun:test";
import type { Proposal } from "../src/server/schema.ts";
import {
  groupGhosts,
  proposalEditsByEntity,
  proposalGhosts,
  renderedProposalIds,
} from "../src/web/ghosts.ts";
import type { ProposalChange } from "../src/shared/types.ts";

// The "present" surface the new-proposal glow gates against: which pending proposals render
// a piece (a ghost card or an edit strip) somewhere on the board. Detection only lights up a
// proposal that has an element to glow, so this set is what the seen-set diff is measured
// against — the proposal twin of the rendered-task-id set.

const proposal = (id: number, status: Proposal["status"], changes: ProposalChange[]): Proposal =>
  ({ id, title: `p${id}`, summary: "", status, changes }) as unknown as Proposal;

/** Fold pending → rendered proposal ids the way the pane does (ghosts + edits). */
function rendered(proposals: Proposal[]): Set<number> {
  const ghosts = groupGhosts(proposalGhosts(proposals));
  const edits = proposalEditsByEntity(proposals);
  return renderedProposalIds(ghosts, edits);
}

test("a pending create renders as a ghost and counts as present", () => {
  const ids = rendered([
    proposal(1, "pending", [
      { op: "create", kind: "task", parentId: 5, fields: { title: "New task" } },
    ]),
  ]);
  expect([...ids]).toEqual([1]);
});

test("a pending edit on an existing node counts as present", () => {
  const ids = rendered([
    proposal(2, "pending", [{ op: "update", kind: "task", id: 10, fields: { title: "Renamed" } }]),
  ]);
  expect([...ids]).toEqual([2]);
});

test("a non-pending proposal renders nothing", () => {
  const ids = rendered([
    proposal(3, "approved", [
      { op: "create", kind: "task", parentId: 5, fields: { title: "Already decided" } },
    ]),
  ]);
  expect(ids.size).toBe(0);
});

test("a change-set proposal is one present id however many pieces it renders", () => {
  const ids = rendered([
    proposal(4, "pending", [
      { op: "create", kind: "goal", fields: { title: "New goal" } },
      { op: "update", kind: "milestone", id: 7, fields: { title: "Renamed milestone" } },
      { op: "archive", kind: "task", id: 8 },
    ]),
  ]);
  expect([...ids]).toEqual([4]);
});

test("only the pending proposals surface, across a mixed set", () => {
  const ids = rendered([
    proposal(1, "pending", [
      { op: "create", kind: "task", parentId: 5, fields: { title: "A" } },
    ]),
    proposal(2, "rejected", [{ op: "update", kind: "task", id: 10, fields: { title: "B" } }]),
    proposal(3, "pending", [{ op: "archive", kind: "milestone", id: 6 }]),
  ]);
  expect([...ids].sort((a, b) => a - b)).toEqual([1, 3]);
});
