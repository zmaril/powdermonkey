import { and, eq, max } from "drizzle-orm";
import {
  type Decision,
  Decision as DecisionEnum,
  type ProposalChange,
  ProposalOp,
  ProposalStatus,
  type VocabKind,
} from "../shared/types.ts";
import { db } from "./db.ts";
import { getProposal, PARENT_COLUMN, repoFor } from "./proposals.ts";
import { goals, milestones, type Proposal, phases, proposals, tasks } from "./schema.ts";

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
    // Position: honor an explicit one, else APPEND to the end of the siblings (max + 1)
    // so an accepted ghost — which renders at the bottom of its list — stays put instead
    // of taking the position-0 column default and jumping to the top on accept.
    if (change.position != null) {
      values.position = change.position;
    } else {
      // biome-ignore lint/suspicious/noExplicitAny: dynamic column lookup by parent-key name.
      const parentColumn: any = parentCol ? (table as any)[parentCol] : null;
      const parentVal = parentCol ? (values[parentCol] as number | undefined) : undefined;
      const where = parentColumn && parentVal != null ? eq(parentColumn, parentVal) : undefined;
      const [agg] = await tx
        .select({ max: max(table.position) })
        .from(table)
        .where(where);
      values.position = (agg?.max ?? -1) + 1;
    }
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

// ── Per-change decisions (inline accept/reject) ────────────────────────────────

export type DecideResult =
  | { ok: true; applied: boolean; proposal: Proposal }
  | { ok: false; error: string; conflicts?: Conflict[] };

/** The change indices that form ONE decidable unit with `start`: the change itself plus
 *  any creates that chain to it through `parentRef` (a created subtree — a new task and
 *  its new phases — is accepted or rejected as a whole, since the children's parent only
 *  exists if the root does). A non-create or ref-less change is a singleton unit. */
function unitIndices(changes: ProposalChange[], start: number): Set<number> {
  const unit = new Set<number>([start]);
  const root = changes[start];
  if (root.op !== ProposalOp.Create || !root.ref) return unit;
  const refs = new Set<string>([root.ref]);
  let grew = true;
  while (grew) {
    grew = false;
    changes.forEach((c, i) => {
      if (unit.has(i)) return;
      if (c.op === ProposalOp.Create && c.parentRef != null && refs.has(c.parentRef)) {
        unit.add(i);
        if (c.ref) refs.add(c.ref);
        grew = true;
      }
    });
  }
  return unit;
}

/** Decide ONE change (and its create-subtree unit) inline: accept → apply it now,
 *  atomically, after a stale-base check on just that unit; reject → drop it. Either way
 *  the unit's changes leave the proposal; when none remain the proposal is closed
 *  (Applied). The per-change counterpart to applyProposal's all-or-nothing apply. */
export async function decideChange(
  id: number,
  changeIndex: number,
  decision: Decision,
): Promise<DecideResult> {
  const proposal = await getProposal(id);
  if (!proposal) return { ok: false, error: "proposal not found" };
  if (proposal.status !== ProposalStatus.Pending && proposal.status !== ProposalStatus.Approved) {
    return { ok: false, error: `proposal is ${proposal.status}, not open` };
  }
  const changes = proposal.changes;
  if (changeIndex < 0 || changeIndex >= changes.length) {
    return { ok: false, error: "change index out of range" };
  }

  const unit = unitIndices(changes, changeIndex);
  const unitChanges = [...unit].sort((a, b) => a - b).map((i) => changes[i]);
  const now = new Date();

  if (decision === DecisionEnum.Accept) {
    // Inline accept AUTO-REPLANS: it always applies against the CURRENT rows (applyChange
    // targets the live row by id), so a base that drifted since the proposal was authored
    // isn't a failure to hand back to the operator — the change just lands on today's plan.
    // (The whole-proposal applyProposal path still guards a stale base; only this
    // per-change inline path self-heals, since the operator is acting on what they see.)
    await db.transaction(async (tx) => {
      const refs = new Map<string, number>();
      for (const c of unitChanges) await applyChange(tx, c, refs, now);
    });
  }

  // Drop the decided unit (accepted ones are already applied above). When the proposal
  // has nothing left to decide, it's closed.
  const remaining = changes.filter((_, i) => !unit.has(i));
  const done = remaining.length === 0;
  const [updated] = await db
    .update(proposals)
    .set({
      changes: remaining,
      status: done ? ProposalStatus.Applied : proposal.status,
      appliedAt: done ? now : proposal.appliedAt,
      updatedAt: now,
    })
    .where(eq(proposals.id, id))
    .returning();
  return { ok: true, applied: decision === DecisionEnum.Accept, proposal: updated as Proposal };
}
