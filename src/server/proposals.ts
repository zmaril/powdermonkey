import { type TSchema, Type } from "@sinclair/typebox";
import { and, eq, isNull } from "drizzle-orm";
import { type ProposalChange, ProposalOp, ProposalStatus, VocabKind } from "../shared/types.ts";
import { goalRepo, milestoneRepo, phaseRepo, taskRepo } from "./crud.ts";
import { db } from "./db.ts";
import { type Proposal, proposals } from "./schema.ts";

// A proposal is a pending change-set of typed vocab mutations. This module owns the
// proposal row's lifecycle decisions (create / list / approve / reject) and the
// `base` snapshot that lets the apply engine (apply.ts) detect a stale base. The
// translation of an approved change-set into actual CRUD lives in apply.ts.

/** The four vocab repos, keyed by the kind a change names. The apply engine and the
 *  base snapshot both resolve a (kind, id) to a row through here. */
export const repoFor = {
  goal: goalRepo,
  milestone: milestoneRepo,
  task: taskRepo,
  phase: phaseRepo,
} as const;

/** The parent foreign-key column a child kind hangs under. Goals are roots (none).
 *  Used by both create (wire the new row's parent) and reorder (reparent). */
export const PARENT_COLUMN: Record<VocabKind, string | null> = {
  goal: null,
  milestone: "goalId",
  task: "milestoneId",
  phase: "taskId",
};

// ── TypeBox body schemas ────────────────────────────────────────────────────
// Hand-written (not drizzle-typebox) because `changes` is a JSON union, not a flat
// column set. Elysia validates the create body against this.

const kindSchema = Type.Union([
  Type.Literal(VocabKind.Goal),
  Type.Literal(VocabKind.Milestone),
  Type.Literal(VocabKind.Task),
  Type.Literal(VocabKind.Phase),
]);

// Fields are an open record — each kind has its own columns, validated for real when
// the change is applied (a create/update goes through the same insert the CRUD route
// would). Keeping it loose here keeps one schema for all four kinds.
const fields = Type.Record(Type.String(), Type.Unknown());

const changeSchema = Type.Union([
  Type.Object({
    op: Type.Literal(ProposalOp.Create),
    kind: kindSchema,
    ref: Type.Optional(Type.String()),
    parentId: Type.Optional(Type.Number()),
    parentRef: Type.Optional(Type.String()),
    fields,
    position: Type.Optional(Type.Number()),
  }),
  Type.Object({
    op: Type.Literal(ProposalOp.Update),
    kind: kindSchema,
    id: Type.Number(),
    fields,
  }),
  Type.Object({
    op: Type.Literal(ProposalOp.Archive),
    kind: kindSchema,
    id: Type.Number(),
  }),
  Type.Object({
    op: Type.Literal(ProposalOp.Reorder),
    kind: kindSchema,
    id: Type.Number(),
    position: Type.Optional(Type.Number()),
    parentId: Type.Optional(Type.Number()),
  }),
]);

export const proposalCreateBody: TSchema = Type.Object({
  title: Type.Optional(Type.String()),
  summary: Type.Optional(Type.String()),
  changes: Type.Array(changeSchema, { minItems: 1 }),
});

/** A stable key for an entity in the base snapshot — `${kind}:${id}`. */
export function baseKey(kind: VocabKind, id: number): string {
  return `${kind}:${id}`;
}

/** Every existing (kind, id) a change-set reads or mutates: the explicit targets of
 *  update/archive/reorder, plus any `parentId` a create/reorder attaches to. These
 *  are the rows whose drift would make the proposal stale, so they're what the base
 *  snapshot covers. */
export function referencedEntities(changes: ProposalChange[]): Array<[VocabKind, number]> {
  const seen = new Set<string>();
  const out: Array<[VocabKind, number]> = [];
  const add = (kind: VocabKind, id: number) => {
    const k = baseKey(kind, id);
    if (seen.has(k)) return;
    seen.add(k);
    out.push([kind, id]);
  };
  for (const c of changes) {
    if (c.op === ProposalOp.Update || c.op === ProposalOp.Archive || c.op === ProposalOp.Reorder)
      add(c.kind, c.id);
    if ((c.op === ProposalOp.Create || c.op === ProposalOp.Reorder) && c.parentId != null) {
      // The parent's kind is the kind one level up from the child.
      const parentKind = parentKindOf(c.kind);
      if (parentKind) add(parentKind, c.parentId);
    }
  }
  return out;
}

/** The kind one level up the hierarchy — a milestone's parent is a goal, etc. */
export function parentKindOf(kind: VocabKind): VocabKind | null {
  return kind === VocabKind.Milestone
    ? VocabKind.Goal
    : kind === VocabKind.Task
      ? VocabKind.Milestone
      : kind === VocabKind.Phase
        ? VocabKind.Task
        : null;
}

/** Snapshot the `updated_at` of every existing row a change-set touches, so apply
 *  can later detect that the plan moved underneath the proposal. A referenced row
 *  that's missing is recorded as "absent" — apply treats a row that later appears,
 *  disappears, or changes timestamp as a conflict. */
export async function snapshotBase(changes: ProposalChange[]): Promise<Record<string, string>> {
  const base: Record<string, string> = {};
  for (const [kind, id] of referencedEntities(changes)) {
    const row = (await repoFor[kind].get(id)) as { updatedAt?: Date } | undefined;
    base[baseKey(kind, id)] = row?.updatedAt ? row.updatedAt.toISOString() : "absent";
  }
  return base;
}

export type CreateProposalInput = {
  title?: string;
  summary?: string;
  changes: ProposalChange[];
};

/** Author a proposal: snapshot the base and persist it pending. */
export async function createProposal(input: CreateProposalInput): Promise<Proposal> {
  const base = await snapshotBase(input.changes);
  const [row] = await db
    .insert(proposals)
    .values({
      title: input.title ?? "",
      summary: input.summary ?? "",
      changes: input.changes,
      base,
      status: ProposalStatus.Pending,
    })
    .returning();
  return row;
}

export async function getProposal(id: number): Promise<Proposal | undefined> {
  const [row] = await db.select().from(proposals).where(eq(proposals.id, id));
  return row;
}

export async function listProposals(opts?: { status?: string }): Promise<Proposal[]> {
  const rows = await db.select().from(proposals).where(isNull(proposals.archivedAt));
  return opts?.status ? rows.filter((p) => p.status === opts.status) : rows;
}

export async function listPending(): Promise<Proposal[]> {
  return db
    .select()
    .from(proposals)
    .where(and(eq(proposals.status, ProposalStatus.Pending), isNull(proposals.archivedAt)));
}

/** Drop a SUBSET of a proposal's changes (by index) WITHOUT applying them — the
 *  revert path for immediate per-change review: a rejected change is simply removed
 *  from the change-set, so it stops appearing in the diff and never touches the plan.
 *  When the last change is dropped the proposal flips to `rejected` (nothing of it
 *  ever landed). Returns the updated proposal, or undefined if it doesn't exist. */
export async function dropProposalChanges(
  id: number,
  indices: number[],
): Promise<Proposal | undefined> {
  const proposal = await getProposal(id);
  if (!proposal) return undefined;
  const drop = new Set(indices.filter((i) => i >= 0 && i < proposal.changes.length));
  if (drop.size === 0) return proposal;
  const remaining = proposal.changes.filter((_, i) => !drop.has(i));
  // Empty via drop with nothing ever applied → rejected; otherwise keep the status.
  const status =
    remaining.length === 0 && proposal.appliedAt == null
      ? ProposalStatus.Rejected
      : proposal.status;
  const [row] = await db
    .update(proposals)
    .set({ changes: remaining, status, updatedAt: new Date() })
    .where(eq(proposals.id, id))
    .returning();
  return row;
}

/** Record a decision. A proposal can only be approved/rejected while pending — a
 *  terminal state (applied/rejected) or a missing row returns undefined. */
export async function decideProposal(
  id: number,
  decision: typeof ProposalStatus.Approved | typeof ProposalStatus.Rejected,
): Promise<Proposal | undefined> {
  const [row] = await db
    .update(proposals)
    .set({ status: decision, updatedAt: new Date() })
    .where(and(eq(proposals.id, id), eq(proposals.status, ProposalStatus.Pending)))
    .returning();
  return row;
}
