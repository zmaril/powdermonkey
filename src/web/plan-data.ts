import { useLiveQuery } from "@tanstack/react-db";
import { useMemo } from "react";
import type { CloudPr } from "../server/events.ts";
import type { Goal, Milestone, Phase, Session, Task } from "../server/schema.ts";
import { ProposalStatus } from "../shared/types.ts";
import { activeTaskIds, type SessionLink } from "./active.ts";
import {
  goalsCollection,
  milestonesCollection,
  phasesCollection,
  proposalsCollection,
  pullRequestsCollection,
  sessionsCollection,
  sessionTasksCollection,
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
  // The tasks a session is working (the reverse of sessionByTask), so the Sessions
  // pane can render one card per session with its task(s) below. Built from the same
  // session_tasks links; resolves over whichever sessions were passed in (live only,
  // or live + archived for the historical view).
  tasksBySession: Map<number, Task[]>;
  // Live PR status (CI / mergeable / draft) for a task, when it has a tracked PR.
  prByTask: Map<number, CloudPr>;
  // Goal/milestone a task hangs under — handy for the flat (ungrouped) views.
  milestoneById: Map<number, Milestone>;
  goalById: Map<number, Goal>;
  // Every task by id — the fresh, server-truth row. Callers that hold an optimistic
  // order (the drag reorder) resolve card CONTENT through this so a field edit renders
  // live even while the sequence is held.
  taskById: Map<number, Task>;
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

  // Each task surfaces the session linked to it through session_tasks, and each
  // session surfaces its tasks (the reverse). Links to sessions not in this slice
  // simply don't resolve, so the same link list works for both the live and full
  // (live + archived) views. When a task has had more than one session (e.g. a
  // teleport archives the remote and cuts a fresh local), sessionByTask prefers a
  // LIVE session, then the newest — so the "current" session wins.
  const sessionById = new Map(sessions.map((s) => [s.id, s]));
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const sessionByTask = new Map<number, Session>();
  const tasksBySession = new Map<number, Task[]>();
  const better = (a: Session, cur: Session): boolean => {
    const aLive = a.archivedAt == null;
    const curLive = cur.archivedAt == null;
    if (aLive !== curLive) return aLive; // a live session always beats an archived one
    return a.id > cur.id; // otherwise the newest run
  };
  for (const l of links) {
    const s = sessionById.get(l.sessionId);
    if (!s) continue;
    const cur = sessionByTask.get(l.taskId);
    if (!cur || better(s, cur)) sessionByTask.set(l.taskId, s);
    const t = taskById.get(l.taskId);
    if (t) {
      const arr = tasksBySession.get(s.id);
      if (arr) arr.push(t);
      else tasksBySession.set(s.id, [t]);
    }
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
    tasksBySession,
    prByTask,
    milestoneById,
    goalById,
    taskById,
  };
}

export type PlanData = {
  idx: Indexes;
  activeIds: Set<number>;
  loading: boolean;
  error: string | null;
};

type RawCollections = {
  goals: Goal[];
  milestones: Milestone[];
  tasks: Task[];
  phases: Phase[];
  sessions: Session[];
  links: SessionLink[];
  prs: CloudPr[];
  loading: boolean;
};

/** The seven live collections that back both read-model hooks below, unwrapped to
 *  plain arrays with one shared `loading` calc — so usePlanData and useFullData
 *  differ only in how they filter/derive, not in how they subscribe. */
function useRawCollections(): RawCollections {
  const goals = useLiveQuery(() => goalsCollection);
  const milestones = useLiveQuery(() => milestonesCollection);
  const tasks = useLiveQuery(() => tasksCollection);
  const phases = useLiveQuery(() => phasesCollection);
  const sessions = useLiveQuery(() => sessionsCollection);
  const sessionTasks = useLiveQuery(() => sessionTasksCollection);
  const cloudPrs = useLiveQuery(() => pullRequestsCollection);

  // "loading" until the core plan tables have delivered their first snapshot.
  const loading = goals.isLoading || milestones.isLoading || tasks.isLoading || sessions.isLoading;
  return {
    goals: goals.data ?? [],
    milestones: milestones.data ?? [],
    tasks: tasks.data ?? [],
    phases: phases.data ?? [],
    sessions: sessions.data ?? [],
    links: sessionTasks.data ?? [],
    prs: cloudPrs.data ?? [],
    loading,
  };
}

/** The shared indexes + derived active set, now sourced from the TanStack DB
 *  collections (synced live from PGlite). No store, no poll, no refetch: each
 *  collection re-emits as deltas arrive and this re-derives. The Indexes shape is
 *  unchanged, so the panes are untouched. */
export function usePlanData(): PlanData {
  const raw = useRawCollections();
  const g = raw.goals.filter(notArchived);
  const m = raw.milestones.filter(notArchived);
  const t = raw.tasks.filter(notArchived);
  const p = raw.phases.filter(notArchived);
  const s = raw.sessions.filter(notArchived);
  const { links, prs } = raw;

  const idx = useMemo(() => buildIndexes(g, m, t, p, s, links, prs), [g, m, t, p, s, links, prs]);
  const activeIds = useMemo(() => activeTaskIds(s, links), [s, links]);

  return { idx, activeIds, loading: raw.loading, error: null };
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

/** The ids of every PENDING proposal — the surface new-proposal detection diffs against
 *  (a proposal that lands as pending is "new"; one that's been approved/rejected drops
 *  out), and the count the glanceable badge shows. Live off the synced collection. */
export function usePendingProposalIds(): Set<number> {
  const proposals = useLiveQuery(() => proposalsCollection);
  return useMemo(() => {
    const ids = new Set<number>();
    for (const p of proposals.data ?? []) if (p.status === ProposalStatus.Pending) ids.add(p.id);
    return ids;
  }, [proposals.data]);
}

export type FullData = {
  idx: Indexes;
  activeIds: Set<number>;
  /** EVERY session, live and historical (landed / stopped / teleported) — the unit the
   *  Sessions pane lists. Unsorted; the pane orders + filters them. */
  sessions: Session[];
  /** All tasks, every status (backlog / active / done / cancelled / archived) — the
   *  unit the Tasks pane lists. */
  tasks: Task[];
  loading: boolean;
};

/** The whole book of work, off the same live collections — UNLIKE usePlanData (which
 *  filters to the non-archived working set), this keeps archived rows in, so the
 *  Sessions and Tasks panes can show live AND history in one filtered list. Indexes
 *  cover the FULL hierarchy (all rows) so a task under an archived goal/milestone still
 *  resolves its context. `activeIds` is still derived from LIVE sessions only — an
 *  archived session never makes a task "active". */
export function useFullData(): FullData {
  const raw = useRawCollections();
  const { goals: g, milestones: m, tasks: t, phases: p, sessions: s, links, prs } = raw;

  const idx = useMemo(() => buildIndexes(g, m, t, p, s, links, prs), [g, m, t, p, s, links, prs]);
  // Liveness is the session's own — only a non-archived session marks its tasks active.
  const liveSessions = useMemo(() => s.filter(notArchived), [s]);
  const activeIds = useMemo(() => activeTaskIds(liveSessions, links), [liveSessions, links]);

  return { idx, activeIds, sessions: s, tasks: t, loading: raw.loading };
}
