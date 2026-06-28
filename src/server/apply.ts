import { and, eq } from "drizzle-orm";
import {
  type ProposalChange,
  ProposalOp,
  ProposalStatus,
  type VocabKind,
} from "../shared/types.ts";
import { db } from "./db.ts";
import { PARENT_COLUMN, getProposal, repoFor } from "./proposals.ts";
import { type Proposal, goals, milestones, phases, proposals, tasks } from "./schema.ts";

// The apply engine: translate an APPROVED proposal's change-set into real vocab CRUD,
// run atomically in one transaction. Before touching anything it re-checks the
// proposal's `base` against the live rows — if the plan moved underneath it, that's a
// stale base and apply refuses rather than clobber. On success it stamps the proposal
// `applied`, which also makes a re-apply a no-op.

// The Drizzle table behind each vocab kind, for the in-transaction writes.
const TABLE = { goal: goals, milestone: milestones, task: tasks, phase: phases } as const;

// Columns the client must never set through a change's `fields` — ids and timestamps
// are server-managed. (The id is generated; timestamps are stamped here.)
const SERVER_MANAGED = new Set(["id", "createdAt", "updatedAt", "archivedAt"]);

function cleanFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (!SERVER_MANAGED.has(k)) out[k] = v;
  }
  return out;
}

/** One drifted entity: what the proposal snapshotted vs. what the row is now. */
export type Conflict = { entity: string; expected: string; actual: string };

export type ApplyResult =
  | {
      ok: true;
      /** false when the proposal was already applied (idempotent re-apply). */
      applied: boolean;
      counts: { create: number; update: number; archive: number; reorder: number };
      proposal: Proposal;
    }
  | { ok: false; error: string; conflicts?: Conflict[] };

/** Compare the proposal's base snapshot against the live rows. Any referenced row
 *  whose `updated_at` no longer matches (or that appeared/disappeared) is a conflict:
 *  the plan changed under the proposal. */
export async function detectConflicts(base: Record<string, string>): Promise<Conflict[]> {
  const conflicts: Conflict[] = [];
  for (const [key, expected] of Object.entries(base)) {
    const [kind, idStr] = key.split(":");
    const row = (await repoFor[kind as VocabKind].get(Number(idStr))) as
      | { updatedAt?: Date }
      | undefined;
    const actual = row?.updatedAt ? row.updatedAt.toISOString() : "absent";
    if (actual !== expected) conflicts.push({ entity: key, expected, actual });
  }
  return conflicts;
}

/** Apply one change inside a transaction, resolving any `parentRef` against the rows
 *  created earlier in this same apply (so a proposal can introduce a whole subtree).
 *  Returns the created id for a create (so its `ref` can be registered), else null. */
async function applyChange(
  // biome-ignore lint/suspicious/noExplicitAny: the Drizzle transaction handle.
  tx: any,
  change: ProposalChange,
  refs: Map<string, number>,
  now: Date,
): Promise<number | null> {
  const table = TABLE[change.kind];
  const parentCol = PARENT_COLUMN[change.kind];

  if (change.op === ProposalOp.Create) {
    const values = cleanFields(change.fields);
    // Wire the parent FK: an existing row (parentId) or a sibling create (parentRef).
    if (parentCol) {
      const parentId =
        change.parentId ?? (change.parentRef != null ? refs.get(change.parentRef) : undefined);
      if (parentId == null) throw new Error(`create ${change.kind}: unresolved parent`);
      values[parentCol] = parentId;
    }
    if (change.position != null) values.position = change.position;
    const [row] = await tx.insert(table).values(values).returning();
    if (change.ref) refs.set(change.ref, row.id);
    return row.id;
  }

  if (change.op === ProposalOp.Update) {
    await tx
      .update(table)
      .set({ ...cleanFields(change.fields), updatedAt: now })
      .where(eq(table.id, change.id));
    return null;
  }

  if (change.op === ProposalOp.Archive) {
    await tx.update(table).set({ archivedAt: now, updatedAt: now }).where(eq(table.id, change.id));
    return null;
  }

  // reorder: a new position and/or a reparent.
  const set: Record<string, unknown> = { updatedAt: now };
  if (change.position != null) set.position = change.position;
  if (change.parentId != null) {
    if (!parentCol) throw new Error(`reorder ${change.kind}: no parent to set`);
    set[parentCol] = change.parentId;
  }
  await tx.update(table).set(set).where(eq(table.id, change.id));
  return null;
}

/** Apply an approved proposal. Idempotent: an already-applied proposal is a no-op;
 *  a stale base surfaces the conflict and changes nothing; otherwise the whole
 *  change-set lands in one transaction and the proposal is marked applied. */
export async function applyProposal(id: number): Promise<ApplyResult> {
  const proposal = await getProposal(id);
  if (!proposal) return { ok: false, error: "proposal not found" };

  // Idempotent re-apply: already done, nothing to do.
  if (proposal.status === ProposalStatus.Applied) {
    return {
      ok: true,
      applied: false,
      counts: { create: 0, update: 0, archive: 0, reorder: 0 },
      proposal,
    };
  }
  if (proposal.status !== ProposalStatus.Approved) {
    return { ok: false, error: `proposal is ${proposal.status}, not approved` };
  }

  // Guard a stale base before mutating anything.
  const conflicts = await detectConflicts(proposal.base);
  if (conflicts.length > 0) {
    return { ok: false, error: "stale base: the plan changed under the proposal", conflicts };
  }

  const counts = { create: 0, update: 0, archive: 0, reorder: 0 };
  const now = new Date();
  const applied = await db.transaction(async (tx) => {
    // Re-assert the proposal is still approved inside the transaction so two
    // concurrent applies can't both run the change-set. The loser sees 0 rows.
    const claimed = await tx
      .update(proposals)
      .set({ status: ProposalStatus.Applied, appliedAt: now, updatedAt: now })
      .where(and(eq(proposals.id, id), eq(proposals.status, ProposalStatus.Approved)))
      .returning();
    if (claimed.length === 0) return null;

    const refs = new Map<string, number>();
    for (const change of proposal.changes) {
      await applyChange(tx, change, refs, now);
      counts[change.op]++;
    }
    return claimed[0] as Proposal;
  });

  // Lost the race to claim it — another apply already marked it applied.
  if (!applied) {
    const fresh = await getProposal(id);
    return {
      ok: true,
      applied: false,
      counts: { create: 0, update: 0, archive: 0, reorder: 0 },
      proposal: fresh ?? proposal,
    };
  }

  return { ok: true, applied: true, counts, proposal: applied };
}
