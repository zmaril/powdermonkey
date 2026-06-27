import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
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
  status: Type.Optional(Type.Union([Type.Literal("todo"), Type.Literal("done")])),
});

const taskInput = Type.Object({
  title: Type.String({ minLength: 1 }),
  phases: Type.Optional(Type.Array(phaseInput)),
});

const milestoneInput = Type.Object({
  title: Type.String({ minLength: 1 }),
  tasks: Type.Optional(Type.Array(taskInput)),
});

const goalInput = Type.Object({
  title: Type.String({ minLength: 1 }),
  objective: Type.Optional(Type.String()),
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
        .values({ title: goal.title, objective: goal.objective ?? "" })
        .returning();
      counts.goals++;
      const goalMilestones = goal.milestones ?? [];
      for (const [mi, ms] of goalMilestones.entries()) {
        const [m] = await tx
          .insert(milestones)
          .values({ goalId: g.id, title: ms.title, position: mi })
          .returning();
        counts.milestones++;
        const milestoneTasks = ms.tasks ?? [];
        for (const [ti, task] of milestoneTasks.entries()) {
          const [t] = await tx
            .insert(tasks)
            .values({ milestoneId: m.id, title: task.title, position: ti })
            .returning();
          counts.tasks++;
          const taskPhases = task.phases ?? [];
          if (taskPhases.length > 0) {
            await tx.insert(phases).values(
              taskPhases.map((p, pi) => ({
                taskId: t.id,
                name: p.name,
                status: p.status ?? ("todo" as const),
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
