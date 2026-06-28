import type { Session, Task } from "../server/schema.ts";

// The in-app, glanceable layer (distinct from OS notifications): when something
// happens in a pane you're not currently looking at, its dockview TAB lights up so
// you notice without leaving the pane you're in. This module is the pure core — what
// changed, and which tab should it light up — kept free of React/dockview so it can
// be unit-tested. The rendering + clear-on-view live in TabActivity.tsx.

// Pane ids — these match the dockview panel ids built in App's default layout.
export const PANE_ACTIVE = "active";
export const PANE_BACKLOG = "backlog";
export const PANE_ARCHIVE = "archive";

/** The slice of state the indicators react to, reduced to plain maps so two
 *  snapshots can be diffed cheaply. */
export type ActivitySnapshot = {
  sessionIds: number[];
  needsInput: Record<number, boolean>;
  taskStatus: Record<number, string>;
};

export function snapshotActivity(sessions: Session[], tasks: Task[]): ActivitySnapshot {
  const needsInput: Record<number, boolean> = {};
  for (const s of sessions) needsInput[s.id] = s.needsInput;
  const taskStatus: Record<number, string> = {};
  for (const t of tasks) taskStatus[t.id] = t.status;
  return { sessionIds: sessions.map((s) => s.id), needsInput, taskStatus };
}

/** Which panes should light up given the change from prev→next. Pure; the caller
 *  suppresses flags for whichever tab is already on screen. The triggers:
 *   • a new live session (dispatch / start-local / teleport) → Active
 *   • a needs-you transition (needs_input false→true)        → Active
 *   • a task status change                                   → the pane it moved
 *     toward: merged → Archive, dispatched → Active, pending → Backlog. */
export function paneActivity(prev: ActivitySnapshot, next: ActivitySnapshot): Set<string> {
  const panes = new Set<string>();
  const prevSessions = new Set(prev.sessionIds);

  for (const id of next.sessionIds) {
    if (!prevSessions.has(id)) panes.add(PANE_ACTIVE); // a session appeared
    if (next.needsInput[id] && !prev.needsInput[id]) panes.add(PANE_ACTIVE); // needs you now
  }

  for (const [idStr, status] of Object.entries(next.taskStatus)) {
    const id = Number(idStr);
    const before = prev.taskStatus[id];
    if (before === undefined || before === status) continue;
    if (status === "merged") panes.add(PANE_ARCHIVE);
    else if (status === "dispatched") panes.add(PANE_ACTIVE);
    else if (status === "pending") panes.add(PANE_BACKLOG);
  }

  return panes;
}
