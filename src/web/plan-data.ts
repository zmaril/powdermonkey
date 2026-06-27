import { useMemo } from "react";
import type { Goal, Milestone, Phase, Session, Task } from "../server/schema.ts";
import { activeTaskIds } from "./active.ts";
import { useStore } from "./store.ts";

// Shared read-model for the two panes. Both the Active and Backlog panes need the
// same goal→milestone→task→phase indexes and the same derived active set, so we
// build them once here and let each pane slice the result. Polling lives in App
// (one timer for the whole app); this hook is pure derivation off the store.

export const byPosition = <T extends { position: number }>(a: T, b: T) => a.position - b.position;

export type Indexes = {
  goals: Goal[];
  milestonesByGoal: Map<number, Milestone[]>;
  tasksByMilestone: Map<number, Task[]>;
  phasesByTask: Map<number, Phase[]>;
  sessionByTask: Map<number, Session>;
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
): Indexes {
  const goalById = new Map<number, Goal>();
  for (const g of goals) goalById.set(g.id, g);

  const milestonesByGoal = new Map<number, Milestone[]>();
  const milestoneById = new Map<number, Milestone>();
  for (const m of [...milestones].sort(byPosition)) {
    milestoneById.set(m.id, m);
    const list = milestonesByGoal.get(m.goalId) ?? [];
    list.push(m);
    milestonesByGoal.set(m.goalId, list);
  }

  const tasksByMilestone = new Map<number, Task[]>();
  for (const t of [...tasks].sort(byPosition)) {
    const list = tasksByMilestone.get(t.milestoneId) ?? [];
    list.push(t);
    tasksByMilestone.set(t.milestoneId, list);
  }

  const phasesByTask = new Map<number, Phase[]>();
  for (const p of [...phases].sort(byPosition)) {
    const list = phasesByTask.get(p.taskId) ?? [];
    list.push(p);
    phasesByTask.set(p.taskId, list);
  }

  const sessionByTask = new Map<number, Session>();
  for (const s of sessions) if (s.taskId != null) sessionByTask.set(s.taskId, s);

  return {
    goals,
    milestonesByGoal,
    tasksByMilestone,
    phasesByTask,
    sessionByTask,
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
  const loading = useStore((s) => s.loading);
  const error = useStore((s) => s.error);

  const idx = useMemo(
    () => buildIndexes(goals, milestones, tasks, phases, sessions),
    [goals, milestones, tasks, phases, sessions],
  );
  const activeIds = useMemo(() => activeTaskIds(sessions), [sessions]);

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
      ),
    [archive],
  );
  const tasks = useMemo(
    () => archive.tasks.filter((t) => t.archivedAt != null || t.status === "merged"),
    [archive.tasks],
  );
  return { idx, tasks };
}
