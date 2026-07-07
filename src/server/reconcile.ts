import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { match } from "ts-pattern";
import {
  DecisionSource,
  PhaseStatus,
  SessionKind,
  SessionState,
  TaskStatus,
} from "../shared/types.ts";
import { db } from "./db.ts";
import { teardownRemoteWorker } from "./exe-dev.ts";
import { commitBodies } from "./git.ts";
import { parsePmNotes } from "./pm-note.ts";
import { phases, sessions, sessionTasks, tasks } from "./schema.ts";
import { landSession } from "./worktree.ts";

// A task in a terminal state — its work is settled (merged) or abandoned (cancelled).
// A session whose every task is terminal is finished and can be archived + torn down.
const TERMINAL_TASK: TaskStatus[] = [TaskStatus.Merged, TaskStatus.Cancelled];

// Progress is driven by what lands on `main`, never by a session self-reporting.
// A commit carries a structured PM-Note naming the work it completed:
//
//   PM-Note: {"v":1,"phases":[<id>,…],"task":<id>}
//     phases  one or more phases finished
//     task    shortcut: the whole task finished (all its phases)
//
// The single-purpose trailers `PM-Phase: <id>` / `PM-Task: <id>` are still read as a
// LEGACY fallback during cutover (a commit predating PM-Note, or a worker that hasn't
// switched yet). Reconciliation scans every commit reachable from main, unions the ids
// from both sources, marks those phases done, and rolls a task to `merged` once all its
// phases are done. It is idempotent: re-marking a done phase is a no-op, so it is safe
// to run on a poll loop.

const MAIN_BRANCH = process.env.PM_MAIN_BRANCH ?? "main";

export type ReconcileResult = {
  phasesMarked: number;
  tasksCompleted: number;
  sessionsArchived: number;
  phaseTrailers: number[];
  taskTrailers: number[];
};

function parseIds(raw: string): number[] {
  return raw
    .split(/[\s,]+/)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
}

function scanTrailers(text: string, key: string): Set<number> {
  const ids = new Set<number>();
  const re = new RegExp(`^\\s*${key}:\\s*(.+)$`, "gim");
  for (const m of text.matchAll(re)) {
    for (const id of parseIds(m[1])) ids.add(id);
  }
  return ids;
}

// Once a task merges, the PR landed, so any session still working it is done by
// definition — leaving it live just makes the Active pane lie. Archive every such
// session here so it happens automatically, no manual Land required.
//
// A session can span several tasks (the session_tasks join), so it's only done
// once EVERY task it's linked to has merged — a session still working an unmerged
// task is left alone. Driven off the tasks' current `merged` status (not just this
// tick's transition), so it's idempotent and self-healing: already-archived
// sessions are excluded, and a teardown that failed last tick is retried. A
// `local` session reuses landSession to tear down its worktree/PTY; a `remote`
// session has no worktree, so we just archive its row.
async function archiveMergedTaskSessions(): Promise<number> {
  const liveSessions = await db
    .select({ id: sessions.id, kind: sessions.kind, vmName: sessions.vmName })
    .from(sessions)
    .where(isNull(sessions.archivedAt));

  // Keep only sessions that have linked tasks whose tasks have ALL reached a terminal
  // state (merged or cancelled). Merged = work landed; cancelled = won't-do — either
  // way the session is finished, so its worker (if any) should be torn down. Driven
  // off current status so it's idempotent/self-healing.
  const live: { id: number; kind: SessionKind; vmName: string | null }[] = [];
  for (const s of liveSessions) {
    const linked = await db
      .select({ status: tasks.status })
      .from(sessionTasks)
      .innerJoin(tasks, eq(sessionTasks.taskId, tasks.id))
      .where(eq(sessionTasks.sessionId, s.id));
    if (linked.length > 0 && linked.every((t) => TERMINAL_TASK.includes(t.status))) live.push(s);
  }

  let archived = 0;
  for (const s of live) {
    // Exhaustive over SessionKind, so a new kind forces a teardown decision here.
    const ok = await match(s.kind)
      // local: reuse landSession to tear down the worktree + PTY.
      .with(SessionKind.Local, async () => {
        const res = await landSession(s.id);
        if (!res.ok) console.warn(`reconcile: could not land session ${s.id}: ${res.error}`);
        return res.ok;
      })
      // remote: no worktree/PTY to tear down, but an exe.dev backend has a worker VM
      // to delete. Archive the row (guarded on archivedAt so a concurrent land/stop
      // can't double-archive); only reach exe.dev if we actually claimed the archive.
      .with(SessionKind.Remote, async () => {
        const [updated] = await db
          .update(sessions)
          .set({ state: SessionState.Idle, archivedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(sessions.id, s.id), isNull(sessions.archivedAt)))
          .returning({ id: sessions.id });
        if (updated) await teardownRemoteWorker(s);
        return Boolean(updated);
      })
      .exhaustive();
    if (ok) archived++;
  }
  return archived;
}

export async function reconcile(): Promise<ReconcileResult> {
  const log = await commitBodies(MAIN_BRANCH);
  // Primary: structured PM-Note payloads. Legacy fallback: the single-purpose
  // PM-Phase / PM-Task trailers. Union both into one phase/task id set — a commit may
  // carry either (or, mid-cutover, both), and reconciliation only cares about the ids.
  const phaseTrailers = scanTrailers(log, "PM-Phase");
  const taskTrailers = scanTrailers(log, "PM-Task");
  for (const note of parsePmNotes(log)) {
    for (const id of note.phases) phaseTrailers.add(id);
    if (note.task != null) taskTrailers.add(note.task);
  }

  // A PM-Task trailer means "all of this task's phases are done" — fold its phases
  // into the phase set so they get marked too.
  const phaseIds = new Set(phaseTrailers);
  if (taskTrailers.size > 0) {
    const owned = await db
      .select({ id: phases.id })
      .from(phases)
      .where(and(inArray(phases.taskId, [...taskTrailers]), isNull(phases.archivedAt)));
    for (const p of owned) phaseIds.add(p.id);
  }

  let phasesMarked = 0;
  if (phaseIds.size > 0) {
    // Mark todo phases done, stamping `reconciled` as the provenance — these
    // earned the truth off `main`. Only todo→done counts as "marked".
    const marked = await db
      .update(phases)
      .set({
        status: PhaseStatus.Done,
        decisionSource: DecisionSource.Reconciled,
        updatedAt: new Date(),
      })
      .where(
        and(
          inArray(phases.id, [...phaseIds]),
          isNull(phases.archivedAt),
          ne(phases.status, PhaseStatus.Done),
        ),
      )
      .returning({ id: phases.id });
    phasesMarked = marked.length;

    // Upgrade any phase an override (operator/supervisor) had asserted done that now
    // has a real trailer on `main`: truth supersedes assertion. Not a new completion,
    // so it doesn't count toward phasesMarked; it just relabels the provenance.
    await db
      .update(phases)
      .set({ decisionSource: DecisionSource.Reconciled, updatedAt: new Date() })
      .where(
        and(
          inArray(phases.id, [...phaseIds]),
          isNull(phases.archivedAt),
          eq(phases.status, PhaseStatus.Done),
          ne(phases.decisionSource, DecisionSource.Reconciled),
        ),
      );
  }

  // Tasks worth re-checking: those explicitly trailered, plus owners of any phase
  // we touched.
  const affected = new Set<number>(taskTrailers);
  if (phaseIds.size > 0) {
    const owners = await db
      .select({ taskId: phases.taskId })
      .from(phases)
      .where(inArray(phases.id, [...phaseIds]));
    for (const o of owners) affected.add(o.taskId);
  }

  let tasksCompleted = 0;
  for (const taskId of affected) {
    const ps = await db
      .select({ status: phases.status })
      .from(phases)
      .where(and(eq(phases.taskId, taskId), isNull(phases.archivedAt)));
    const allDone = ps.length > 0 && ps.every((p) => p.status === PhaseStatus.Done);
    // Explicit PM-Task trailer completes the task even if it has no phases.
    if (allDone || taskTrailers.has(taskId)) {
      const done = await db
        .update(tasks)
        .set({
          status: TaskStatus.Merged,
          decisionSource: DecisionSource.Reconciled,
          updatedAt: new Date(),
        })
        .where(and(eq(tasks.id, taskId), ne(tasks.status, TaskStatus.Merged)))
        .returning({ id: tasks.id });
      tasksCompleted += done.length;

      // Same upgrade as for phases: a task an override closed that now has its work
      // landed on `main` gets relabelled `reconciled` (truth wins). Already merged,
      // so it's not a new completion — only the provenance changes.
      await db
        .update(tasks)
        .set({ decisionSource: DecisionSource.Reconciled, updatedAt: new Date() })
        .where(
          and(
            eq(tasks.id, taskId),
            eq(tasks.status, TaskStatus.Merged),
            ne(tasks.decisionSource, DecisionSource.Reconciled),
          ),
        );
    }
  }

  const sessionsArchived = await archiveMergedTaskSessions();

  // No explicit client ping here: the phase/task/session writes above go through
  // the DB, so the /sync feed (app.ts) streams them on its own. An idle pass writes
  // nothing and so wakes nobody.

  return {
    phasesMarked,
    tasksCompleted,
    sessionsArchived,
    phaseTrailers: [...phaseTrailers],
    taskTrailers: [...taskTrailers],
  };
}
