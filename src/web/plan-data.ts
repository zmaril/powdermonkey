import { useLiveQuery } from "@tanstack/react-db";
import { useMemo } from "react";
import type { CloudPr } from "../server/events.ts";
import type { Goal, Milestone, Phase, Session, Task } from "../server/schema.ts";
import { TaskStatus } from "../shared/types.ts";
import { type SessionLink, activeTaskIds } from "./active.ts";
import {
  goalsCollection,
  milestonesCollection,
  phasesCollection,
  proposalsCollection,
  pullRequestsCollection,
  sessionTasksCollection,
  sessionsCollection,
  tasksCollection,
} from "./collections.ts";
import {
  type EntityEdit,
  type GroupedGhosts,
  groupGhosts,
  proposalEditsByEntity,
  proposalGhosts,
} from "./ghosts.ts";

// The collections stream every row (live + archived); the live panes want only the
// non-archived ones. sessionTasks carry no archived_at — their liveness is the
// session's, which buildIndexes already resolves — so they're never filtered here.
const notArchived = <T extends { archivedAt?: Date | null }>(r: T): boolean => r.archivedAt == null;

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

/** The shared indexes + derived active set, now sourced from the TanStack DB
 *  collections (synced live from PGlite). No store, no poll, no refetch: each
 *  collection re-emits as deltas arrive and this re-derives. The Indexes shape is
 *  unchanged, so the panes are untouched. */
export function usePlanData(): PlanData {
  const goals = useLiveQuery(() => goalsCollection);
  const milestones = useLiveQuery(() => milestonesCollection);
  const tasks = useLiveQuery(() => tasksCollection);
  const phases = useLiveQuery(() => phasesCollection);
  const sessions = useLiveQuery(() => sessionsCollection);
  const sessionTasks = useLiveQuery(() => sessionTasksCollection);
  const cloudPrs = useLiveQuery(() => pullRequestsCollection);

  const g = (goals.data ?? []).filter(notArchived);
  const m = (milestones.data ?? []).filter(notArchived);
  const t = (tasks.data ?? []).filter(notArchived);
  const p = (phases.data ?? []).filter(notArchived);
  const s = (sessions.data ?? []).filter(notArchived);
  const links: SessionLink[] = sessionTasks.data ?? [];
  const prs = cloudPrs.data ?? [];

  const idx = useMemo(() => buildIndexes(g, m, t, p, s, links, prs), [g, m, t, p, s, links, prs]);
  const activeIds = useMemo(() => activeTaskIds(s, links), [s, links]);

  // "loading" until the core plan tables have delivered their first snapshot.
  const loading = goals.isLoading || milestones.isLoading || tasks.isLoading || sessions.isLoading;
  return { idx, activeIds, loading, error: null };
}

/** Pending proposals' create-task changes, projected into ghost cards keyed by the
 *  milestone they'd land under — live off the synced proposals collection, so a new
 *  proposal's ghosts appear (and an accepted/rejected one's vanish) without a refresh. */
export function useProposalGhosts(): GroupedGhosts {
  const proposals = useLiveQuery(() => proposalsCollection);
  return useMemo(() => groupGhosts(proposalGhosts(proposals.data ?? [])), [proposals.data]);
}

/** Pending edits on existing nodes (rename / delete / move, any kind), keyed by
 *  `${kind}:${id}`, so each node can render the proposed change in place — live off the
 *  same collection. */
export function useProposalEdits(): Map<string, EntityEdit[]> {
  const proposals = useLiveQuery(() => proposalsCollection);
  return useMemo(() => proposalEditsByEntity(proposals.data ?? []), [proposals.data]);
}

/** The archive view, off the same collections. `tasks` is the book of work:
 *  everything finished (merged) or archived. Indexes cover the FULL hierarchy (all
 *  rows, archived included) so a task under an archived goal/milestone still resolves
 *  its context. */
export function useArchiveData(): { idx: Indexes; tasks: Task[] } {
  const goals = useLiveQuery(() => goalsCollection);
  const milestones = useLiveQuery(() => milestonesCollection);
  const tasks = useLiveQuery(() => tasksCollection);
  const phases = useLiveQuery(() => phasesCollection);
  const sessions = useLiveQuery(() => sessionsCollection);
  const sessionTasks = useLiveQuery(() => sessionTasksCollection);

  const allTasks = tasks.data ?? [];
  const idx = useMemo(
    () =>
      buildIndexes(
        goals.data ?? [],
        milestones.data ?? [],
        allTasks,
        phases.data ?? [],
        sessions.data ?? [],
        sessionTasks.data ?? [],
      ),
    [goals.data, milestones.data, allTasks, phases.data, sessions.data, sessionTasks.data],
  );
  const archivedTasks = useMemo(
    () => allTasks.filter((t) => t.archivedAt != null || t.status === TaskStatus.Merged),
    [allTasks],
  );
  return { idx, tasks: archivedTasks };
}
