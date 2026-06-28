import { and, eq, isNull, ne } from "drizzle-orm";
import { DoneSource, PhaseStatus, TaskStatus } from "../shared/types.ts";
import { db } from "./db.ts";
import { type Phase, type Task, phases, tasks } from "./schema.ts";

// Operator-asserted completion — the non-reconciled path. Reconciliation owns
// `done_source = reconciled` (work that earned the truth off `main`); everything
// here stamps `operator` instead, for work that genuinely finished but never
// produced a trailer (a squash that dropped it, out-of-band work, a won't-do
// item, a phase-less task). See docs/completion-model.md.
//
// The one invariant these all hold: operator actions never override or undo a
// `reconciled` row. Reconciled completion belongs to `main` — it's undone by
// changing `main`, not by a button. So reopen only ever clears `operator` rows,
// and the reconciler may later upgrade an `operator` row to `reconciled` (truth
// wins) but never the reverse.

/** Roll a task to `merged` when all its live phases are done — the operator twin of
 *  reconcile's task roll-up. Provenance is `operator` if any contributing phase was
 *  asserted by hand, else `reconciled`. Never downgrades an already-merged task. */
async function rollUpTask(taskId: number): Promise<void> {
  const ps = await db
    .select({ status: phases.status, doneSource: phases.doneSource })
    .from(phases)
    .where(and(eq(phases.taskId, taskId), isNull(phases.archivedAt)));
  if (ps.length === 0 || !ps.every((p) => p.status === PhaseStatus.Done)) return;
  const source = ps.some((p) => p.doneSource === DoneSource.Operator)
    ? DoneSource.Operator
    : DoneSource.Reconciled;
  await db
    .update(tasks)
    .set({ status: TaskStatus.Merged, doneSource: source, updatedAt: new Date() })
    .where(and(eq(tasks.id, taskId), ne(tasks.status, TaskStatus.Merged)));
}

/** Operator marks a single phase done (e.g. a squash dropped just one trailer).
 *  Stamps `operator` provenance and rolls the owning task up if that finished it. */
export async function completePhase(id: number): Promise<Phase | undefined> {
  const [row] = await db
    .update(phases)
    .set({ status: PhaseStatus.Done, doneSource: DoneSource.Operator, updatedAt: new Date() })
    .where(and(eq(phases.id, id), ne(phases.status, PhaseStatus.Done)))
    .returning();
  // Already done (or unknown id): return whatever's there without re-stamping, so we
  // never relabel a reconciled phase as operator.
  const phase = row ?? (await db.select().from(phases).where(eq(phases.id, id)))[0];
  if (row) await rollUpTask(row.taskId);
  return phase;
}

/** Reopen an operator-asserted phase back to todo. Refuses reconciled phases — those
 *  reflect `main`. If reopening leaves an operator-merged task incomplete, the task
 *  drops back to pending too (a reconciled-merged task is never touched). */
export async function reopenPhase(id: number): Promise<Phase | undefined> {
  const [phase] = await db.select().from(phases).where(eq(phases.id, id));
  if (!phase) return undefined;
  if (phase.doneSource !== DoneSource.Operator) return phase; // never reopen reconciled work
  const [updated] = await db
    .update(phases)
    .set({ status: PhaseStatus.Todo, doneSource: null, updatedAt: new Date() })
    .where(eq(phases.id, id))
    .returning();
  // If the owning task was merged by operator assertion and is no longer all-done,
  // walk it back. A reconciled-merged task stays put — it belongs to `main`.
  await db
    .update(tasks)
    .set({ status: TaskStatus.Pending, doneSource: null, updatedAt: new Date() })
    .where(
      and(
        eq(tasks.id, phase.taskId),
        eq(tasks.status, TaskStatus.Merged),
        eq(tasks.doneSource, DoneSource.Operator),
      ),
    );
  return updated;
}

/** Operator marks a whole task done — the won't-do / out-of-band / phase-less case.
 *  Mirrors the `PM-Task:` shortcut: every still-todo phase is closed (as `operator`),
 *  while already-done phases keep their provenance. */
export async function completeTask(id: number): Promise<Task | undefined> {
  await db
    .update(phases)
    .set({ status: PhaseStatus.Done, doneSource: DoneSource.Operator, updatedAt: new Date() })
    .where(
      and(eq(phases.taskId, id), isNull(phases.archivedAt), ne(phases.status, PhaseStatus.Done)),
    );
  const [task] = await db
    .update(tasks)
    .set({ status: TaskStatus.Merged, doneSource: DoneSource.Operator, updatedAt: new Date() })
    .where(eq(tasks.id, id))
    .returning();
  return task;
}

/** Reopen an operator-completed task back to pending, walking its operator-asserted
 *  phases back to todo. Reconciled completions (task or phase) are left as-is. */
export async function reopenTask(id: number): Promise<Task | undefined> {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, id));
  if (!task) return undefined;
  if (task.doneSource !== DoneSource.Operator) return task; // never reopen reconciled work
  await db
    .update(phases)
    .set({ status: PhaseStatus.Todo, doneSource: null, updatedAt: new Date() })
    .where(and(eq(phases.taskId, id), eq(phases.doneSource, DoneSource.Operator)));
  const [updated] = await db
    .update(tasks)
    .set({ status: TaskStatus.Pending, doneSource: null, updatedAt: new Date() })
    .where(eq(tasks.id, id))
    .returning();
  return updated;
}
