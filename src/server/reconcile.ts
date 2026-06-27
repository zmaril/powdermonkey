import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { db } from "./db.ts";
import { commitBodies } from "./git.ts";
import { phases, sessions, tasks } from "./schema.ts";
import { landSession } from "./worktree.ts";

// Progress is driven by what lands on `main`, never by a session self-reporting.
// A commit carries trailers naming the work it completed:
//
//   PM-Phase: <id>     one or more phases finished (repeatable / comma-separated)
//   PM-Task:  <id>     shortcut: the whole task finished (all its phases)
//
// Reconciliation scans every commit reachable from main, marks those phases done,
// and rolls a task to `merged` once all its phases are done. It is idempotent:
// re-marking a done phase is a no-op, so it is safe to run on a poll loop.

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
    .map((s) => Number(s))
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

// Once a task merges, the PR landed, so any session still attached to it is done
// by definition — leaving it live just makes the Active pane lie. Archive every
// such session here so it happens automatically, no manual Land required.
//
// Driven off the task's current `merged` status (not just this tick's transition),
// so it's idempotent and self-healing: already-archived sessions are excluded, a
// teardown that failed last tick is retried, and a session belonging to a still-
// running (non-merged) task is never touched. A `local` session reuses landSession
// to tear down its worktree/PTY; a `remote` session has no worktree, so we just
// archive its row.
async function archiveMergedTaskSessions(): Promise<number> {
  const live = await db
    .select({ id: sessions.id, kind: sessions.kind })
    .from(sessions)
    .innerJoin(tasks, eq(sessions.taskId, tasks.id))
    .where(and(isNull(sessions.archivedAt), eq(tasks.status, "merged")));

  let archived = 0;
  for (const s of live) {
    if (s.kind === "local") {
      const res = await landSession(s.id);
      if (res.ok) archived++;
      else console.warn(`reconcile: could not land session ${s.id}: ${res.error}`);
      continue;
    }
    // Remote session: no worktree/PTY to tear down — just archive the row. Guarded
    // on archivedAt so a concurrent land/stop can't double-archive.
    const [updated] = await db
      .update(sessions)
      .set({ state: "idle", archivedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(sessions.id, s.id), isNull(sessions.archivedAt)))
      .returning({ id: sessions.id });
    if (updated) archived++;
  }
  return archived;
}

export async function reconcile(): Promise<ReconcileResult> {
  const log = await commitBodies(MAIN_BRANCH);
  const phaseTrailers = scanTrailers(log, "PM-Phase");
  const taskTrailers = scanTrailers(log, "PM-Task");

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
    const marked = await db
      .update(phases)
      .set({ status: "done", updatedAt: new Date() })
      .where(
        and(
          inArray(phases.id, [...phaseIds]),
          isNull(phases.archivedAt),
          ne(phases.status, "done"),
        ),
      )
      .returning({ id: phases.id });
    phasesMarked = marked.length;
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
    const allDone = ps.length > 0 && ps.every((p) => p.status === "done");
    // Explicit PM-Task trailer completes the task even if it has no phases.
    if (allDone || taskTrailers.has(taskId)) {
      const done = await db
        .update(tasks)
        .set({ status: "merged", updatedAt: new Date() })
        .where(and(eq(tasks.id, taskId), ne(tasks.status, "merged")))
        .returning({ id: tasks.id });
      tasksCompleted += done.length;
    }
  }

  const sessionsArchived = await archiveMergedTaskSessions();

  return {
    phasesMarked,
    tasksCompleted,
    sessionsArchived,
    phaseTrailers: [...phaseTrailers],
    taskTrailers: [...taskTrailers],
  };
}
