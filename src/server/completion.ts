import { and, eq, isNull, ne } from "drizzle-orm";
import { DecisionSource, type OverrideSource, PhaseStatus, TaskStatus } from "../shared/types.ts";
import { db } from "./db.ts";
import { type Phase, type Task, phases, tasks } from "./schema.ts";

// Operator/supervisor-driven decisions — the non-reconciled path. Reconciliation
// owns `decision_source = reconciled` (a trailer landed on `main`); everything here
// stamps the caller's `source` instead — `operator` (you, by hand in the UI) or
// `supervisor` (you delegated the call to the supervisor agent). The decisions:
// complete work that never produced a trailer, close a task as won't-do
// (`cancelled`), or reopen one of those. See docs/completion-model.md.
//
// The one invariant these all hold: an override never touches a `reconciled` row.
// Reconciled state belongs to `main` — it's undone by changing `main`, not by a
// button. So reopen only ever clears `operator`/`supervisor` rows, and the
// reconciler may later upgrade an override row to `reconciled` (truth wins) but
// never the reverse.

/** Roll a task to `merged` when all its live phases are done — the override twin of
 *  reconcile's task roll-up. Provenance is the caller's `source` if any contributing
 *  phase was asserted by hand, else `reconciled`. Never downgrades a merged task. */
async function rollUpTask(taskId: number, source: OverrideSource): Promise<void> {
  const ps = await db
    .select({ status: phases.status, decisionSource: phases.decisionSource })
    .from(phases)
    .where(and(eq(phases.taskId, taskId), isNull(phases.archivedAt)));
  if (ps.length === 0 || !ps.every((p) => p.status === PhaseStatus.Done)) return;
  // If every phase was reconciled off `main`, the roll-up is reconciled too;
  // otherwise the override that finished the last phase owns the call.
  const finalSource = ps.every((p) => p.decisionSource === DecisionSource.Reconciled)
    ? DecisionSource.Reconciled
    : source;
  await db
    .update(tasks)
    .set({ status: TaskStatus.Merged, decisionSource: finalSource, updatedAt: new Date() })
    .where(and(eq(tasks.id, taskId), ne(tasks.status, TaskStatus.Merged)));
}

/** Mark a single phase done (e.g. a squash dropped just one trailer). Stamps the
 *  caller's `source` and rolls the owning task up if that finished it. */
export async function completePhase(
  id: number,
  source: OverrideSource,
): Promise<Phase | undefined> {
  const [row] = await db
    .update(phases)
    .set({ status: PhaseStatus.Done, decisionSource: source, updatedAt: new Date() })
    .where(and(eq(phases.id, id), ne(phases.status, PhaseStatus.Done)))
    .returning();
  // Already done (or unknown id): return whatever's there without re-stamping, so we
  // never relabel a reconciled phase.
  const phase = row ?? (await db.select().from(phases).where(eq(phases.id, id)))[0];
  if (row) await rollUpTask(row.taskId, source);
  return phase;
}

/** Reopen an override-completed phase back to todo. Refuses reconciled phases — those
 *  reflect `main`. If reopening leaves an override-merged task incomplete, the task
 *  drops back to pending too (a reconciled-merged task is never touched). */
export async function reopenPhase(id: number): Promise<Phase | undefined> {
  const [phase] = await db.select().from(phases).where(eq(phases.id, id));
  if (!phase) return undefined;
  if (phase.decisionSource === DecisionSource.Reconciled) return phase; // never reopen reconciled work
  const [updated] = await db
    .update(phases)
    .set({ status: PhaseStatus.Todo, decisionSource: null, updatedAt: new Date() })
    .where(eq(phases.id, id))
    .returning();
  // If the owning task was merged by an override and is no longer all-done, walk it
  // back. A reconciled-merged task stays put — it belongs to `main`.
  await db
    .update(tasks)
    .set({ status: TaskStatus.Pending, decisionSource: null, updatedAt: new Date() })
    .where(
      and(
        eq(tasks.id, phase.taskId),
        eq(tasks.status, TaskStatus.Merged),
        ne(tasks.decisionSource, DecisionSource.Reconciled),
      ),
    );
  return updated;
}

/** Mark a whole task done — the out-of-band / phase-less completion. Mirrors the
 *  `PM-Task:` shortcut: every still-todo phase is closed (with the caller's
 *  `source`), while already-done phases keep their provenance. */
export async function completeTask(id: number, source: OverrideSource): Promise<Task | undefined> {
  await db
    .update(phases)
    .set({ status: PhaseStatus.Done, decisionSource: source, updatedAt: new Date() })
    .where(
      and(eq(phases.taskId, id), isNull(phases.archivedAt), ne(phases.status, PhaseStatus.Done)),
    );
  const [task] = await db
    .update(tasks)
    .set({ status: TaskStatus.Merged, decisionSource: source, updatedAt: new Date() })
    .where(eq(tasks.id, id))
    .returning();
  return task;
}

/** Close a task as won't-do — the cancellation decision. Terminal but NOT done: the
 *  task goes to `cancelled` and is archived (soft-deleted) so it leaves the live panes
 *  and files into the book of work. Its phases are left as-is — a cancelled task never
 *  counts toward progress, so there's nothing to mark. `decision_source` records who
 *  made the call. */
export async function cancelTask(id: number, source: OverrideSource): Promise<Task | undefined> {
  const [task] = await db
    .update(tasks)
    .set({
      status: TaskStatus.Cancelled,
      decisionSource: source,
      archivedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, id))
    .returning();
  return task;
}

/** Reopen an override-decided task (merged-by-hand OR cancelled) back to pending,
 *  walking its override-completed phases back to todo and clearing any archive set by
 *  a cancel. Reconciled completions (task or phase) are left as-is — they belong to
 *  `main`. */
export async function reopenTask(id: number): Promise<Task | undefined> {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, id));
  if (!task) return undefined;
  if (task.decisionSource === DecisionSource.Reconciled) return task; // never reopen reconciled work
  await db
    .update(phases)
    .set({ status: PhaseStatus.Todo, decisionSource: null, updatedAt: new Date() })
    .where(and(eq(phases.taskId, id), ne(phases.decisionSource, DecisionSource.Reconciled)));
  const [updated] = await db
    .update(tasks)
    .set({
      status: TaskStatus.Pending,
      decisionSource: null,
      archivedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, id))
    .returning();
  return updated;
}
