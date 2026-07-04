// Projecting a node's pending edits onto a PREVIEW copy of it, so the card can render as
// it WILL be — the after-state — instead of describing the change in a strip. Pure data:
// given a node + the edits that act on it, return the resulting field values plus a
// per-field diff (what changed, from what) and the change handles that drive accept/reject.

import type { Phase, Task } from "../../../server/schema.ts";
import { PhaseStatus, ProposalOp, type TaskKind } from "../../../shared/types.ts";
import type { EntityEdit, Ghost } from "../../ghosts.ts";

/** A pending change's decide() handle + which op it is — everything the accept/reject
 *  control on the preview needs to apply or drop exactly this change. */
export type ChangeRef = {
  proposalId: number;
  changeIndex: number;
  proposalTitle: string;
  op: ProposalOp;
};

export function changeRef(e: EntityEdit | Ghost, op: ProposalOp): ChangeRef {
  return {
    proposalId: e.proposalId,
    changeIndex: e.changeIndex,
    proposalTitle: e.proposalTitle,
    op,
  };
}

/** A renamed field: the old text, the proposed text, and whether they actually differ. */
export type TextDiff = { before: string; after: string; changed: boolean };

/** How a narrative field (task description, goal objective) moved. */
export type ProseState = "same" | "added" | "edited" | "cleared";
export type ProseDiff = { before: string | null; after: string | null; state: ProseState };

function proseDiff(before: string | null, after: string | null): ProseDiff {
  const b = before ?? "";
  const a = after ?? "";
  const state: ProseState = a === b ? "same" : b === "" ? "added" : a === "" ? "cleared" : "edited";
  return { before, after, state };
}

/** A task, projected to its after-state with a per-field diff. `changes` are the
 *  card-level edits (update / archive / reorder) each accept/reject decides. */
export type TaskPreview = {
  changes: ChangeRef[];
  archived: boolean;
  reordered: boolean;
  title: TextDiff;
  kind: { before: TaskKind; after: TaskKind; changed: boolean };
  description: ProseDiff;
};

export function taskPreview(task: Task, edits: EntityEdit[]): TaskPreview {
  let title = task.title;
  let kind = task.kind;
  let description: string | null = task.description ?? null;
  let archived = false;
  let reordered = false;
  const changes: ChangeRef[] = [];
  for (const e of edits) {
    changes.push(changeRef(e, e.op));
    if (e.op === ProposalOp.Archive) archived = true;
    else if (e.op === ProposalOp.Reorder) reordered = true;
    else if (e.op === ProposalOp.Update) {
      if (e.newTitle != null) title = e.newTitle;
      if (e.newKind != null) kind = e.newKind as TaskKind;
      if (e.newDescription !== undefined) description = e.newDescription;
    }
  }
  return {
    changes,
    archived,
    reordered,
    title: { before: task.title, after: title, changed: title !== task.title },
    kind: { before: task.kind, after: kind, changed: kind !== task.kind },
    description: proseDiff(task.description ?? null, description),
  };
}

/** A goal / milestone header, projected to its after-state. Milestones carry only a
 *  title; goals also carry an objective (their narrative field). */
export type HeaderPreview = {
  changes: ChangeRef[];
  archived: boolean;
  title: TextDiff;
  objective?: ProseDiff;
};

export function headerPreview(
  current: { title: string; objective?: string },
  edits: EntityEdit[],
): HeaderPreview {
  let title = current.title;
  let objective = current.objective ?? null;
  let archived = false;
  const changes: ChangeRef[] = [];
  const touchesObjective = current.objective !== undefined;
  for (const e of edits) {
    changes.push(changeRef(e, e.op));
    if (e.op === ProposalOp.Archive) archived = true;
    else if (e.op === ProposalOp.Update) {
      if (e.newTitle != null) title = e.newTitle;
      if (e.newObjective !== undefined) objective = e.newObjective;
    }
  }
  return {
    changes,
    archived,
    title: { before: current.title, after: title, changed: title !== current.title },
    objective: touchesObjective ? proseDiff(current.objective ?? null, objective) : undefined,
  };
}

/** One row in the previewed phase checklist: an existing phase carried forward
 *  (unchanged / renamed / struck for delete) or a proposed new phase spliced in at its
 *  slot. `change` is the edit that accept/reject decides (absent for an unchanged row). */
export type PhaseRow = {
  key: string;
  /** The phase to render (rename already applied; a synthetic row for an added phase). */
  phase: Phase;
  status: "same" | "renamed" | "removed" | "added";
  /** The old name, when renamed — so the row can show old → new. */
  before?: string;
  change?: ChangeRef;
};

/** The task's checklist as it WILL be: existing phases with their pending rename/delete
 *  applied, plus proposed new phases spliced in at their position. */
export function previewPhases(
  phases: Phase[],
  phaseEdits: EntityEdit[],
  phaseGhosts: Ghost[],
): PhaseRow[] {
  const editById = new Map<number, EntityEdit>();
  for (const e of phaseEdits) editById.set(e.id, e);

  const rows: PhaseRow[] = phases.map((p) => {
    const e = editById.get(p.id);
    if (e?.op === ProposalOp.Archive) {
      return { key: `p${p.id}`, phase: p, status: "removed", change: changeRef(e, e.op) };
    }
    if (e?.op === ProposalOp.Update && e.newTitle != null && e.newTitle !== p.name) {
      return {
        key: `p${p.id}`,
        phase: { ...p, name: e.newTitle },
        status: "renamed",
        before: p.name,
        change: changeRef(e, e.op),
      };
    }
    return { key: `p${p.id}`, phase: p, status: "same" };
  });

  // Splice new-phase ghosts in at their proposed position (default: append), so an added
  // phase shows at the spot it lands, not tacked on regardless.
  const ghostRows: { at: number; row: PhaseRow }[] = phaseGhosts.map((g, i) => ({
    at: g.position ?? rows.length + i,
    row: {
      key: `g${g.proposalId}-${g.changeIndex}`,
      phase: {
        id: -(g.changeIndex + 1),
        name: g.title,
        status: PhaseStatus.Todo,
      } as unknown as Phase,
      status: "added",
      change: changeRef(g, ProposalOp.Create),
    },
  }));
  for (const { at, row } of ghostRows.sort((a, b) => a.at - b.at)) {
    rows.splice(Math.min(at, rows.length), 0, row);
  }
  return rows;
}
