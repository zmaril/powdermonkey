import type { Goal, Milestone, Phase, Session, Task } from "../server/schema.ts";
import { type Rollup, rollup } from "./progress.ts";

// The rolled-up plan tree: goals → milestones → tasks → phases, the same shape the
// browser assembles client-side from five flat lists. `buildTree` does it once,
// server-side, and attaches a phase-grain `rollup` at every level so a goal/
// milestone/task each carry their own done/total/pct without the client recomputing.

export type TaskNode = Task & {
  phases: Phase[];
  // The latest session attached to this task, if any (sessions live outside the
  // hierarchy and are matched back by taskId).
  session: Session | null;
  rollup: Rollup;
};
export type MilestoneNode = Milestone & { tasks: TaskNode[]; rollup: Rollup };
export type GoalNode = Goal & { milestones: MilestoneNode[]; rollup: Rollup };

export type PlanTree = { goals: GoalNode[]; rollup: Rollup };

export type TreeInput = {
  goals: Goal[];
  milestones: Milestone[];
  tasks: Task[];
  phases: Phase[];
  sessions: Session[];
};

const byPosition = <T extends { position: number }>(a: T, b: T) => a.position - b.position;

/** Assemble the flat vocab lists into one nested, rolled-up tree. Pure: the same
 * inputs always yield the same tree, which is what makes it testable in isolation. */
export function buildTree(input: TreeInput): PlanTree {
  const phasesByTask = new Map<number, Phase[]>();
  for (const p of [...input.phases].sort(byPosition)) {
    const list = phasesByTask.get(p.taskId) ?? [];
    list.push(p);
    phasesByTask.set(p.taskId, list);
  }

  const tasksByMilestone = new Map<number, Task[]>();
  for (const t of [...input.tasks].sort(byPosition)) {
    const list = tasksByMilestone.get(t.milestoneId) ?? [];
    list.push(t);
    tasksByMilestone.set(t.milestoneId, list);
  }

  const milestonesByGoal = new Map<number, Milestone[]>();
  for (const m of [...input.milestones].sort(byPosition)) {
    const list = milestonesByGoal.get(m.goalId) ?? [];
    list.push(m);
    milestonesByGoal.set(m.goalId, list);
  }

  // Last session wins per task — mirrors the client's sessionByTask index.
  const sessionByTask = new Map<number, Session>();
  for (const s of input.sessions) if (s.taskId != null) sessionByTask.set(s.taskId, s);

  const allPhases: Phase[] = [];
  const goals: GoalNode[] = [];
  for (const goal of [...input.goals].sort((a, b) => a.id - b.id)) {
    const goalPhases: Phase[] = [];
    const milestoneNodes: MilestoneNode[] = [];
    for (const milestone of milestonesByGoal.get(goal.id) ?? []) {
      const milestonePhases: Phase[] = [];
      const taskNodes: TaskNode[] = [];
      for (const task of tasksByMilestone.get(milestone.id) ?? []) {
        const phases = phasesByTask.get(task.id) ?? [];
        milestonePhases.push(...phases);
        taskNodes.push({
          ...task,
          phases,
          session: sessionByTask.get(task.id) ?? null,
          rollup: rollup(phases),
        });
      }
      goalPhases.push(...milestonePhases);
      milestoneNodes.push({ ...milestone, tasks: taskNodes, rollup: rollup(milestonePhases) });
    }
    allPhases.push(...goalPhases);
    goals.push({ ...goal, milestones: milestoneNodes, rollup: rollup(goalPhases) });
  }

  return { goals, rollup: rollup(allPhases) };
}
