import { and, eq, isNull } from "drizzle-orm";
import { PhaseStatus } from "../shared/types.ts";
import { db } from "./db.ts";
import { type Task, milestones, phases, repos, tasks } from "./schema.ts";

// Task fan-out: author ONE task spec and stamp it across N repos at once, one task per
// repo, all sharing the milestone/title/phases. This is how "add the linter to three
// repos" is authored once instead of copy-pasting the same task three times — the
// multi-select repo picker (pre-filled from the inherited default, see plan.ts) feeds
// this. Distinct from the nested `/plan` loader: that authors the whole tree; this adds
// a set of sibling tasks under an existing milestone. See docs/vocabulary.md § Task.

/** One phase to stamp on every fanned-out task. Mirrors the plan loader's phase input. */
export type FanOutPhase = { name: string };

export type FanOutInput = {
  milestoneId: number;
  title: string;
  repoIds: number[];
  phases?: FanOutPhase[];
  // Where the fanned tasks sit in the milestone. Omitted → appended after the existing
  // tasks; given → the first task lands here and the rest follow in order.
  position?: number;
};

export type FanOutResult = { ok: true; tasks: Task[] } | { ok: false; error: string };

/** Create one task per repo under `milestoneId`, each with its own copy of `phases`.
 *  Runs in a single transaction so a fan-out is all-or-nothing. `repoIds` is deduped
 *  (picking a repo twice is still one task); an empty pick, an unknown milestone, or an
 *  unknown repo is rejected before anything is written. */
export async function fanOutTasks(input: FanOutInput): Promise<FanOutResult> {
  const repoIds = [...new Set(input.repoIds)];
  if (repoIds.length === 0) return { ok: false, error: "no repos selected" };

  const [milestone] = await db
    .select()
    .from(milestones)
    .where(and(eq(milestones.id, input.milestoneId), isNull(milestones.archivedAt)));
  if (!milestone) return { ok: false, error: `unknown milestone "${input.milestoneId}"` };

  // Every picked repo must be a live registry row — a fan-out onto a repo that doesn't
  // exist (or was archived) is a mistake, not something to write a dangling FK for.
  const liveRepos = new Set(
    (await db.select({ id: repos.id }).from(repos).where(isNull(repos.archivedAt))).map(
      (r) => r.id,
    ),
  );
  const missing = repoIds.filter((id) => !liveRepos.has(id));
  if (missing.length > 0) return { ok: false, error: `unknown repo "${missing.join(", ")}"` };

  const phaseInputs = input.phases ?? [];

  return db.transaction(async (tx) => {
    // Append after the milestone's existing live tasks unless an explicit base is given,
    // so a fan-out lands at the end of the list rather than colliding on position 0.
    let base = input.position;
    if (base == null) {
      const existing = await tx
        .select({ position: tasks.position })
        .from(tasks)
        .where(and(eq(tasks.milestoneId, input.milestoneId), isNull(tasks.archivedAt)));
      base = existing.reduce((max, t) => Math.max(max, t.position + 1), 0);
    }

    const created: Task[] = [];
    for (const [i, repoId] of repoIds.entries()) {
      const [t] = await tx
        .insert(tasks)
        .values({ milestoneId: input.milestoneId, title: input.title, position: base + i, repoId })
        .returning();
      if (phaseInputs.length > 0) {
        await tx.insert(phases).values(
          phaseInputs.map((p, pi) => ({
            taskId: t.id,
            name: p.name,
            status: PhaseStatus.Todo,
            position: pi,
          })),
        );
      }
      created.push(t);
    }
    return { ok: true, tasks: created };
  });
}
