import type { Phase, Proposal, Task } from "../server/schema.ts";
import { type ProposalChange, ProposalOp, ProposalStatus, VocabKind } from "../shared/types.ts";
import type { Indexes } from "./plan-data.ts";

// Projections from pending proposals onto the plan tree, so every proposed change can be
// reviewed IN PLACE: a create renders as a "ghost" under the parent it'd land in, an
// edit (update / archive / reorder) renders on the existing node it acts on. Works for
// all four kinds (goal · milestone · task · phase) so the Backlog can show the whole
// change-set wherever each piece belongs, with per-change accept/reject.

// jsonb arrives parsed over the sync, but be defensive in case a row carries it as text.
function changesOf(p: Proposal): ProposalChange[] {
  const c = p.changes as unknown;
  if (typeof c === "string") {
    try {
      return JSON.parse(c) as ProposalChange[];
    } catch {
      return [];
    }
  }
  return (c as ProposalChange[]) ?? [];
}

/** A stable key for an existing node, matching `proposalEditsByEntity`'s map keys. */
export function entityKey(kind: VocabKind, id: number): string {
  return `${kind}:${id}`;
}

// A proposed NEW node (a create change), placed under the parent it'd be created in.
export type Ghost = {
  proposalId: number;
  proposalTitle: string;
  /** Index of the create change in the proposal — the handle the decide API takes. */
  changeIndex: number;
  kind: VocabKind;
  /** The existing parent it lands under (milestone for a task, goal for a milestone, task
   *  for a phase), or null for a new goal. */
  parentId: number | null;
  /** Title (goal/milestone/task) or name (phase). */
  title: string;
  /** Child phase names, for a task ghost — shown as its checklist. */
  phases: string[];
};

// A proposed change on an EXISTING node.
export type EntityEdit = {
  proposalId: number;
  proposalTitle: string;
  changeIndex: number;
  kind: VocabKind;
  /** The existing node this edit acts on. */
  id: number;
  op: ProposalOp; // update | archive | reorder
  /** For an update: the proposed new title/name, when the change sets one. */
  newTitle?: string;
  /** For an update: the proposed new task kind (task | bug | spike), when set. */
  newKind?: string;
  /** For an update: the proposed new description, when the change touches it (null =
   *  cleared). `undefined` means the change doesn't touch the description at all. */
  newDescription?: string | null;
  /** For a reorder: the proposed new position (0 = top) and/or parent. */
  position?: number;
  parentId?: number;
};

/** "Proposed: new task / milestone / goal / phase" for a ghost. */
export function ghostLabel(g: Ghost): string {
  return `Proposed: new ${g.kind}`;
}

/** How an edit reads on its node — said concretely so the operator can tell what it does
 *  (where a move lands, what a rename becomes), per kind. */
export function editLabel(e: EntityEdit): string {
  if (e.op === ProposalOp.Archive) return `Proposed: delete this ${e.kind}`;
  if (e.op === ProposalOp.Reorder) {
    if (e.parentId != null) {
      const parent =
        e.kind === VocabKind.Task
          ? `milestone m${e.parentId}`
          : e.kind === VocabKind.Milestone
            ? `goal g${e.parentId}`
            : e.kind === VocabKind.Phase
              ? `task t${e.parentId}`
              : `#${e.parentId}`;
      return `Proposed: move to ${parent}`;
    }
    if (e.position === 0) return "Proposed: move to the top";
    if (e.position != null) return `Proposed: move to position ${e.position + 1}`;
    return "Proposed: reorder";
  }
  // Update: list EVERY field the change touches, so accepting is never a surprise — a
  // rename that also retags or rewrites the description must say so, not read as "rename".
  const parts: string[] = [];
  if (e.newTitle != null) parts.push(`rename → "${e.newTitle}"`);
  if (e.newKind != null) parts.push(`kind → ${e.newKind}`);
  if (e.newDescription !== undefined) {
    const d = e.newDescription;
    parts.push(
      d
        ? `description → "${d.length > 44 ? `${d.slice(0, 44).trimEnd()}…` : d}"`
        : "clear description",
    );
  }
  return parts.length ? `Proposed: ${parts.join(" · ")}` : "Proposed: edit";
}

/** Every pending create, as a ghost placed under its parent. A create parented to a
 *  sibling create (parentRef) is nested — it rides along when its parent ghost is
 *  accepted — so it isn't rendered on its own. Task ghosts gather their child phases. */
export function proposalGhosts(proposals: Proposal[]): Ghost[] {
  const out: Ghost[] = [];
  for (const p of proposals) {
    if (p.status !== ProposalStatus.Pending) continue;
    const changes = changesOf(p);
    changes.forEach((c, i) => {
      if (c.op !== ProposalOp.Create) return;
      if (c.parentRef != null) return; // nested under another create — not standalone
      if (c.kind !== VocabKind.Goal && c.parentId == null) return; // needs an existing parent
      const title =
        c.kind === VocabKind.Phase ? String(c.fields.name ?? "") : String(c.fields.title ?? "");
      const phases =
        c.kind === VocabKind.Task
          ? changes.flatMap((d) =>
              d.op === ProposalOp.Create &&
              d.kind === VocabKind.Phase &&
              c.ref != null &&
              d.parentRef === c.ref
                ? [String(d.fields.name ?? "")]
                : [],
            )
          : [];
      out.push({
        proposalId: p.id,
        proposalTitle: p.title,
        changeIndex: i,
        kind: c.kind,
        parentId: c.parentId ?? null,
        title: title || "(untitled)",
        phases,
      });
    });
  }
  return out;
}

/** The ghosts grouped by where they render: tasks under a milestone, milestones under a
 *  goal, phases under a task, and brand-new goals on their own. */
export type GroupedGhosts = {
  tasksByMilestone: Map<number, Ghost[]>;
  milestonesByGoal: Map<number, Ghost[]>;
  phasesByTask: Map<number, Ghost[]>;
  goals: Ghost[];
};

export function groupGhosts(ghosts: Ghost[]): GroupedGhosts {
  const tasksByMilestone = new Map<number, Ghost[]>();
  const milestonesByGoal = new Map<number, Ghost[]>();
  const phasesByTask = new Map<number, Ghost[]>();
  const goals: Ghost[] = [];
  const push = (m: Map<number, Ghost[]>, k: number, g: Ghost) => {
    const list = m.get(k) ?? [];
    list.push(g);
    m.set(k, list);
  };
  for (const g of ghosts) {
    if (g.kind === VocabKind.Goal) goals.push(g);
    else if (g.parentId == null) continue;
    else if (g.kind === VocabKind.Task) push(tasksByMilestone, g.parentId, g);
    else if (g.kind === VocabKind.Milestone) push(milestonesByGoal, g.parentId, g);
    else if (g.kind === VocabKind.Phase) push(phasesByTask, g.parentId, g);
  }
  return { tasksByMilestone, milestonesByGoal, phasesByTask, goals };
}

/** Pending edits on existing nodes (update / archive / reorder, any kind), keyed by
 *  `${kind}:${id}` so each node can find the changes that act on it. */
export function proposalEditsByEntity(proposals: Proposal[]): Map<string, EntityEdit[]> {
  const out = new Map<string, EntityEdit[]>();
  for (const p of proposals) {
    if (p.status !== ProposalStatus.Pending) continue;
    changesOf(p).forEach((c, i) => {
      if (
        c.op !== ProposalOp.Update &&
        c.op !== ProposalOp.Archive &&
        c.op !== ProposalOp.Reorder
      ) {
        return;
      }
      const isUpdate = c.op === ProposalOp.Update;
      const titleOrName =
        isUpdate && (c.fields.title ?? c.fields.name) != null
          ? String(c.fields.title ?? c.fields.name)
          : undefined;
      // Surface every content field an update touches (not just the title) so the review
      // strip shows the whole change. `"description" in fields` keeps an explicit clear.
      const newKind = isUpdate && c.fields.kind != null ? String(c.fields.kind) : undefined;
      const newDescription =
        isUpdate && "description" in c.fields ? (c.fields.description as string | null) : undefined;
      const edit: EntityEdit = {
        proposalId: p.id,
        proposalTitle: p.title,
        changeIndex: i,
        kind: c.kind,
        id: c.id,
        op: c.op,
        newTitle: titleOrName,
        newKind,
        newDescription,
        position: c.op === ProposalOp.Reorder ? c.position : undefined,
        parentId: c.op === ProposalOp.Reorder ? c.parentId : undefined,
      };
      const key = entityKey(c.kind, c.id);
      const list = out.get(key) ?? [];
      list.push(edit);
      out.set(key, list);
    });
  }
  return out;
}

/** Gather a task's pending-proposal render props in one place: its phases, edits on the
 *  task itself, proposed new phases, and edits on its existing phases — the bundle both
 *  the grouped card and the flat row feed to their task view. */
export function taskProposalProps(
  t: Task,
  idx: Indexes,
  ghosts: GroupedGhosts,
  edits: Map<string, EntityEdit[]>,
): {
  phases: Phase[];
  edits: EntityEdit[] | undefined;
  phaseGhosts: Ghost[] | undefined;
  phaseEdits: EntityEdit[];
} {
  const phases = idx.phasesByTask.get(t.id) ?? [];
  return {
    phases,
    edits: edits.get(entityKey(VocabKind.Task, t.id)),
    phaseGhosts: ghosts.phasesByTask.get(t.id),
    phaseEdits: phases.flatMap((p) => edits.get(entityKey(VocabKind.Phase, p.id)) ?? []),
  };
}
