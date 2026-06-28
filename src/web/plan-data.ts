import { useMemo } from "react";
import type { CloudPr } from "../server/events.ts";
import type { Goal, Milestone, Phase, Session, Task } from "../server/schema.ts";
import { TaskStatus } from "../shared/types.ts";
import { type SessionLink, activeTaskIds } from "./active.ts";
import { useStore } from "./store.ts";

// Shared read-model for the two panes. Both the Active and Backlog panes need the
// same goal→milestone→task→phase indexes and the same derived active set, so we
// build them once here and let each pane slice the result. Polling lives in App
// (one timer for the whole app); this hook is pure derivation off the store.

export const byPosition = <T extends { position: number }>(a: T, b: T) => a.position - b.position;

/** Stable "starred first" ordering for a group of tasks — starred ones float to
 *  the top, everything else keeps its existing relative order (JS sort is stable). */
export const starFirst = <T extends { starred: boolean }>(tasks: T[]): T[] =>
  [...tasks].sort((a, b) => Number(b.starred) - Number(a.starred));

export type Indexes = {
  goals: Goal[];
  milestonesByGoal: Map<number, Milestone[]>;
  tasksByMilestone: Map<number, Task[]>;
  phasesByTask: Map<number, Phase[]>;
  sessionByTask: Map<number, Session>;
  // Live PR status (CI / mergeable / draft) for a task, when it has a tracked PR.
  prByTask: Map<number, CloudPr>;
  // Goal/milestone a task hangs under — handy for the flat (ungrouped) views.
  milestoneById: Map<number, Milestone>;
  goalById: Map<number, Goal>;
};

export function phasesUnder(tasks: Task[], idx: Indexes): Phase[] {
  return tasks.flatMap((t) => idx.phasesByTask.get(t.id) ?? []);
}

export function buildIndexes(
  goals: Goal[],
  milestones: Milestone[],
  tasks: Task[],
  phases: Phase[],
  sessions: Session[],
  links: SessionLink[],
  cloudPrs: CloudPr[] = [],
): Indexes {
  const sortedMilestones = [...milestones].sort(byPosition);
  const goalById = new Map(goals.map((g) => [g.id, g]));
  const milestoneById = new Map(sortedMilestones.map((m) => [m.id, m]));
  const milestonesByGoal = Map.groupBy(sortedMilestones, (m) => m.goalId);
  const tasksByMilestone = Map.groupBy([...tasks].sort(byPosition), (t) => t.milestoneId);
  const phasesByTask = Map.groupBy([...phases].sort(byPosition), (p) => p.taskId);

  // Each task surfaces the live session linked to it through session_tasks. Links
  // to sessions not in this slice (archived, or the other slice) simply don't
  // resolve, so the same link list works for both the live and archive views.
  const sessionById = new Map(sessions.map((s) => [s.id, s]));
  const sessionByTask = new Map<number, Session>();
  for (const l of links) {
    const s = sessionById.get(l.sessionId);
    if (s) sessionByTask.set(l.taskId, s);
  }

  // Prefer a merged PR, else the highest-numbered (newest) one, if a task somehow
  // has more than one tracked PR.
  const prByTask = new Map<number, CloudPr>();
  for (const pr of cloudPrs) {
    const cur = prByTask.get(pr.taskId);
    if (!cur || pr.merged || (!cur.merged && pr.number > cur.number)) prByTask.set(pr.taskId, pr);
  }

  return {
    goals,
    milestonesByGoal,
    tasksByMilestone,
    phasesByTask,
    sessionByTask,
    prByTask,
    milestoneById,
    goalById,
  };
}

export type PlanData = {
  idx: Indexes;
  activeIds: Set<number>;
  loading: boolean;
  error: string | null;
};

/** Pure derivation off the store: the shared indexes plus the derived active set.
 *  No polling here — App owns the single refresh timer. */
export function usePlanData(): PlanData {
  const goals = useStore((s) => s.goals);
  const milestones = useStore((s) => s.milestones);
  const tasks = useStore((s) => s.tasks);
  const phases = useStore((s) => s.phases);
  const sessions = useStore((s) => s.sessions);
  const sessionTasks = useStore((s) => s.sessionTasks);
  const cloudPrs = useStore((s) => s.cloudPrs);
  const loading = useStore((s) => s.loading);
  const error = useStore((s) => s.error);

  const idx = useMemo(
    () => buildIndexes(goals, milestones, tasks, phases, sessions, sessionTasks, cloudPrs),
    [goals, milestones, tasks, phases, sessions, sessionTasks, cloudPrs],
  );
  const activeIds = useMemo(() => activeTaskIds(sessions, sessionTasks), [sessions, sessionTasks]);

  return { idx, activeIds, loading, error };
}

/** Derivation off the archive slice (live + archived rows). `tasks` is the book of
 *  work: everything finished (merged) or archived. Indexes cover the full
 *  hierarchy so a task under an archived goal/milestone still resolves context. */
export function useArchiveData(): { idx: Indexes; tasks: Task[] } {
  const archive = useStore((s) => s.archive);
  const idx = useMemo(
    () =>
      buildIndexes(
        archive.goals,
        archive.milestones,
        archive.tasks,
        archive.phases,
        archive.sessions,
        archive.sessionTasks,
      ),
    [archive],
  );
  const tasks = useMemo(
    () => archive.tasks.filter((t) => t.archivedAt != null || t.status === TaskStatus.Merged),
    [archive.tasks],
  );
  return { idx, tasks };
}
