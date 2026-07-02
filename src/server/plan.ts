import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { PhaseStatus } from "../shared/types.ts";
import { db } from "./db.ts";
import { goals, milestones, phases, tasks } from "./schema.ts";

// A plan is authored as a nested, id-less tree: goal → milestones → tasks → phases.
// The loader assigns integer ids and wires the foreign keys as it inserts, so the
// author never references an id by hand. Editing individual entities afterward goes
// through the CRUD endpoints, not by re-posting the plan.
//
// Schema is TypeBox (same as the derived CRUD bodies and Elysia itself) so the
// `/plan` route validates it natively — no second validation library.

const phaseInput = Type.Object({
  name: Type.String({ minLength: 1 }),
  status: Type.Optional(
    Type.Union([Type.Literal(PhaseStatus.Todo), Type.Literal(PhaseStatus.Done)]),
  ),
});

const taskInput = Type.Object({
  title: Type.String({ minLength: 1 }),
  // The repo this task targets (its dispatch environment). Optional at authoring —
  // a repo-less task is backfilled to the supervisor's own repo on boot.
  repoId: Type.Optional(Type.Number()),
  phases: Type.Optional(Type.Array(phaseInput)),
});

const milestoneInput = Type.Object({
  title: Type.String({ minLength: 1 }),
  // Default repo for tasks under this milestone (overrides the goal's). Cascades to a
  // repo-less task at load time; the task can still pin its own.
  repoId: Type.Optional(Type.Number()),
  tasks: Type.Optional(Type.Array(taskInput)),
});

const goalInput = Type.Object({
  title: Type.String({ minLength: 1 }),
  objective: Type.Optional(Type.String()),
  // Default repo the goal's tasks inherit unless a milestone/task overrides it.
  repoId: Type.Optional(Type.Number()),
  milestones: Type.Optional(Type.Array(milestoneInput)),
});

export const planSchema = Type.Object({ goals: Type.Array(goalInput) });

export type Plan = Static<typeof planSchema>;

/** Validate + coerce arbitrary input into a Plan (applies defaults, throws on bad shape). */
export function parsePlan(input: unknown): Plan {
  return Value.Parse(planSchema, input);
}

export type LoadResult = { goals: number; milestones: number; tasks: number; phases: number };

/** Insert the whole authored tree in one transaction; returns counts per level. */
export async function loadPlan(plan: Plan): Promise<LoadResult> {
  return db.transaction(async (tx) => {
    const counts: LoadResult = { goals: 0, milestones: 0, tasks: 0, phases: 0 };
    for (const goal of plan.goals) {
      const [g] = await tx
        .insert(goals)
        .values({ title: goal.title, objective: goal.objective ?? "", repoId: goal.repoId })
        .returning();
      counts.goals++;
      const goalMilestones = goal.milestones ?? [];
      for (const [mi, ms] of goalMilestones.entries()) {
        const [m] = await tx
          .insert(milestones)
          .values({ goalId: g.id, title: ms.title, position: mi, repoId: ms.repoId })
          .returning();
        counts.milestones++;
        // A task inherits its default repo from the nearest scope that declares one —
        // itself, else its milestone, else its goal — so a goal/milestone pinned to a
        // repo pre-fills every task under it without repeating the id per task. An
        // explicit task.repoId always wins.
        const inheritedRepoId = ms.repoId ?? goal.repoId;
        const milestoneTasks = ms.tasks ?? [];
        for (const [ti, task] of milestoneTasks.entries()) {
          const [t] = await tx
            .insert(tasks)
            .values({
              milestoneId: m.id,
              title: task.title,
              position: ti,
              repoId: task.repoId ?? inheritedRepoId,
            })
            .returning();
          counts.tasks++;
          const taskPhases = task.phases ?? [];
          if (taskPhases.length > 0) {
            await tx.insert(phases).values(
              taskPhases.map((p, pi) => ({
                taskId: t.id,
                name: p.name,
                status: p.status ?? PhaseStatus.Todo,
                position: pi,
              })),
            );
            counts.phases += taskPhases.length;
          }
        }
      }
    }
    return counts;
  });
}
