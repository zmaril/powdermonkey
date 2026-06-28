import { and, asc, eq, isNull } from "drizzle-orm";
import type { ProposalChange, TaskStatus, VocabKind } from "../shared/types.ts";
import { db } from "./db.ts";
import { goals, milestones, phases, tasks } from "./schema.ts";

// The plan as markdown — the single review-and-edit surface for plans and proposals.
// A plan tree (goal → milestone → task → phase) serializes to markdown headings + a
// task checklist, and parses back losslessly: every node carries a trailing id chip
// (`g1`, `m6`, `t110`, `p41`) so a parse-back knows which live row each line is, an
// untagged node is a create, and document order is position. So "edit the plan" is
// "edit the text": render → edit → parse → reconcile.
//
//   # Ship auth `g1`
//   > let users log in
//
//   ## Tokens `m1`
//
//   ### JWT issuing `t1`
//   - [ ] write tests `p1`
//   - [x] implement `p2`
//
// A proposal renders the same way — its change-set projected onto the current tree —
// so reviewing/diffing a proposal is reviewing/diffing two markdown documents.

// ── The in-memory plan tree (the shape both serialize and parse speak) ──────────
// Ids are optional: a node parsed from hand-written markdown (or created by a
// proposal) has none until it's persisted.
export type MdPhase = { id?: number; name: string; done: boolean };
export type MdTask = { id?: number; title: string; status?: TaskStatus; phases: MdPhase[] };
export type MdMilestone = { id?: number; title: string; tasks: MdTask[] };
export type MdGoal = { id?: number; title: string; objective: string; milestones: MdMilestone[] };
export type MdPlan = { goals: MdGoal[] };

// The single-letter id chip prefix per level.
const CHIP: Record<"goal" | "milestone" | "task" | "phase", string> = {
  goal: "g",
  milestone: "m",
  task: "t",
  phase: "p",
};

/** A trailing `` `g12` `` id chip on a heading/line, e.g. "Ship auth `g1`". */
function chip(prefix: string, id?: number): string {
  return id == null ? "" : ` \`${prefix}${id}\``;
}

// ── Serialize: plan tree → markdown ────────────────────────────────────────────

/** Render a plan tree as markdown. The inverse of `parsePlanMarkdown` for every
 *  field the markdown carries (ids, titles, objective, phase name + done, order). */
export function planToMarkdown(plan: MdPlan): string {
  const out: string[] = [];
  for (const goal of plan.goals) {
    out.push(`# ${goal.title}${chip(CHIP.goal, goal.id)}`);
    if (goal.objective.trim()) out.push(`> ${goal.objective}`);
    for (const m of goal.milestones) {
      out.push("");
      out.push(`## ${m.title}${chip(CHIP.milestone, m.id)}`);
      for (const t of m.tasks) {
        out.push("");
        out.push(`### ${t.title}${chip(CHIP.task, t.id)}`);
        for (const p of t.phases) {
          out.push(`- [${p.done ? "x" : " "}] ${p.name}${chip(CHIP.phase, p.id)}`);
        }
      }
    }
    out.push("");
  }
  // Trim a trailing blank line for a clean round-trip.
  return `${out.join("\n").replace(/\n+$/, "")}\n`;
}

// ── Parse: markdown → plan tree ────────────────────────────────────────────────

// Split a heading/line's text into its title and an optional trailing id chip.
const CHIP_RE = /^(.*?)\s*`([gmtp])(\d+)`\s*$/;

function splitChip(text: string, want: string): { title: string; id?: number } {
  const m = text.match(CHIP_RE);
  if (m && m[2] === want) return { title: m[1].trim(), id: Number(m[3]) };
  // A chip of the wrong kind (or none) is treated as part of the title — we don't
  // silently adopt it as this node's id.
  return { title: text.trim() };
}

/** Parse plan markdown back into a tree. Untagged nodes have no `id` (they're
 *  creates); tagged nodes carry their existing id. Order is preserved as position. */
export function parsePlanMarkdown(md: string): MdPlan {
  const plan: MdPlan = { goals: [] };
  let goal: MdGoal | null = null;
  let milestone: MdMilestone | null = null;
  let task: MdTask | null = null;

  for (const raw of md.split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;

    if (line.startsWith("# ")) {
      const { title, id } = splitChip(line.slice(2), "g");
      goal = { id, title, objective: "", milestones: [] };
      milestone = null;
      task = null;
      plan.goals.push(goal);
    } else if (line.startsWith("## ")) {
      if (!goal) continue;
      const { title, id } = splitChip(line.slice(3), "m");
      milestone = { id, title, tasks: [] };
      task = null;
      goal.milestones.push(milestone);
    } else if (line.startsWith("### ")) {
      if (!milestone) continue;
      const { title, id } = splitChip(line.slice(4), "t");
      task = { id, title, phases: [] };
      milestone.tasks.push(task);
    } else if (/^- \[[ xX]\] /.test(line)) {
      if (!task) continue;
      const done = /^- \[[xX]\] /.test(line);
      const { title, id } = splitChip(line.replace(/^- \[[ xX]\] /, ""), "p");
      task.phases.push({ id, name: title, done });
    } else if (line.startsWith(">")) {
      // A blockquote right under a goal (before any milestone) is its objective.
      if (goal && !milestone) {
        const text = line.replace(/^>\s?/, "");
        goal.objective = goal.objective ? `${goal.objective}\n${text}` : text;
      }
    }
    // Any other line (prose, headings deeper than h3) is ignored — the format only
    // claims the four node shapes above.
  }
  return plan;
}

// ── Load the live plan tree from the DB ────────────────────────────────────────

/** Build the current plan tree from the live (non-archived) rows, ordered as the UI
 *  shows them (milestones/tasks/phases by position, goals by id). */
export async function loadPlanTree(): Promise<MdPlan> {
  const [gs, ms, ts, ps] = await Promise.all([
    db.select().from(goals).where(isNull(goals.archivedAt)),
    db
      .select()
      .from(milestones)
      .where(isNull(milestones.archivedAt))
      .orderBy(asc(milestones.position)),
    db.select().from(tasks).where(isNull(tasks.archivedAt)).orderBy(asc(tasks.position)),
    db.select().from(phases).where(isNull(phases.archivedAt)).orderBy(asc(phases.position)),
  ]);

  const phasesByTask = new Map<number, MdPhase[]>();
  for (const p of ps) {
    const list = phasesByTask.get(p.taskId) ?? [];
    list.push({ id: p.id, name: p.name, done: p.status === "done" });
    phasesByTask.set(p.taskId, list);
  }
  const tasksByMilestone = new Map<number, MdTask[]>();
  for (const t of ts) {
    const list = tasksByMilestone.get(t.milestoneId) ?? [];
    list.push({ id: t.id, title: t.title, status: t.status, phases: phasesByTask.get(t.id) ?? [] });
    tasksByMilestone.set(t.milestoneId, list);
  }
  const milestonesByGoal = new Map<number, MdMilestone[]>();
  for (const m of ms) {
    const list = milestonesByGoal.get(m.goalId) ?? [];
    list.push({ id: m.id, title: m.title, tasks: tasksByMilestone.get(m.id) ?? [] });
    milestonesByGoal.set(m.goalId, list);
  }
  return {
    goals: [...gs]
      .sort((a, b) => a.id - b.id)
      .map((g) => ({
        id: g.id,
        title: g.title,
        objective: g.objective,
        milestones: milestonesByGoal.get(g.id) ?? [],
      })),
  };
}

/** The current plan, rendered as markdown — `tasks → markdown`. */
export async function planMarkdown(): Promise<string> {
  return planToMarkdown(await loadPlanTree());
}

// ── Project a proposal's change-set onto the tree (no DB writes) ────────────────

function fieldStr(fields: Record<string, unknown>, key: string): string {
  const v = fields[key];
  return v == null ? "" : String(v);
}

/** Walk every node in a tree, yielding [kind, node] so a change can find its target. */
function findNode(
  plan: MdPlan,
  kind: VocabKind,
  id: number,
):
  | { node: MdGoal | MdMilestone | MdTask | MdPhase; container: unknown[]; index: number }
  | undefined {
  if (kind === "goal") {
    const index = plan.goals.findIndex((g) => g.id === id);
    return index < 0 ? undefined : { node: plan.goals[index], container: plan.goals, index };
  }
  for (const g of plan.goals) {
    if (kind === "milestone") {
      const index = g.milestones.findIndex((m) => m.id === id);
      if (index >= 0) return { node: g.milestones[index], container: g.milestones, index };
    }
    for (const m of g.milestones) {
      if (kind === "task") {
        const index = m.tasks.findIndex((t) => t.id === id);
        if (index >= 0) return { node: m.tasks[index], container: m.tasks, index };
      }
      for (const t of m.tasks) {
        if (kind === "phase") {
          const index = t.phases.findIndex((p) => p.id === id);
          if (index >= 0) return { node: t.phases[index], container: t.phases, index };
        }
      }
    }
  }
  return undefined;
}

/** The child list a kind hangs in, under a given parent id (for create/reorder). */
function childList(plan: MdPlan, kind: VocabKind, parentId: number): unknown[] | undefined {
  if (kind === "milestone") return plan.goals.find((g) => g.id === parentId)?.milestones;
  if (kind === "task")
    return plan.goals.flatMap((g) => g.milestones).find((m) => m.id === parentId)?.tasks;
  if (kind === "phase")
    return plan.goals
      .flatMap((g) => g.milestones)
      .flatMap((m) => m.tasks)
      .find((t) => t.id === parentId)?.phases;
  return plan.goals; // goal
}

/** Apply a proposal's change-set to a tree in memory, returning the projected tree —
 *  what the plan would look like if the proposal were applied. Created nodes have no
 *  id (so they render chip-less, reading as additions in a markdown diff). */
export function applyChangesToTree(base: MdPlan, changes: ProposalChange[]): MdPlan {
  const plan: MdPlan = structuredClone(base);
  const refs = new Map<string, MdGoal | MdMilestone | MdTask | MdPhase>();

  for (const c of changes) {
    if (c.op === "create") {
      const f = c.fields;
      const node =
        c.kind === "phase"
          ? ({ name: fieldStr(f, "name"), done: f.status === "done" } as MdPhase)
          : c.kind === "goal"
            ? ({
                title: fieldStr(f, "title"),
                objective: fieldStr(f, "objective"),
                milestones: [],
              } as MdGoal)
            : c.kind === "milestone"
              ? ({ title: fieldStr(f, "title"), tasks: [] } as MdMilestone)
              : ({ title: fieldStr(f, "title"), phases: [] } as MdTask);
      if (c.ref) refs.set(c.ref, node);
      // Destination child list: a sibling create (parentRef, no id yet) attaches
      // directly to that node's children; otherwise resolve an existing parent id.
      const list =
        c.parentRef != null
          ? childArrayOf(refs.get(c.parentRef), c.kind)
          : c.parentId != null
            ? childList(plan, c.kind, c.parentId)
            : plan.goals;
      // biome-ignore lint/suspicious/noExplicitAny: the list is the right child type.
      if (list) (list as any[]).splice(c.position ?? list.length, 0, node);
    } else if (c.op === "archive") {
      const hit = findNode(plan, c.kind, c.id);
      if (hit) hit.container.splice(hit.index, 1);
    } else if (c.op === "update") {
      const hit = findNode(plan, c.kind, c.id);
      if (hit) applyFields(c.kind, hit.node, c.fields);
    } else if (c.op === "reorder") {
      const hit = findNode(plan, c.kind, c.id);
      if (!hit) continue;
      hit.container.splice(hit.index, 1);
      const dest = c.parentId != null ? childList(plan, c.kind, c.parentId) : hit.container;
      // biome-ignore lint/suspicious/noExplicitAny: the list is the right child type.
      if (dest) (dest as any[]).splice(c.position ?? dest.length, 0, hit.node);
    }
  }
  return plan;
}

/** The child array on a freshly-created parent node, for a sibling create that
 *  parents to it via `parentRef`. */
function childArrayOf(
  parent: MdGoal | MdMilestone | MdTask | MdPhase | undefined,
  childKind: VocabKind,
): unknown[] | undefined {
  if (!parent) return undefined;
  if (childKind === "milestone") return (parent as MdGoal).milestones;
  if (childKind === "task") return (parent as MdMilestone).tasks;
  if (childKind === "phase") return (parent as MdTask).phases;
  return undefined;
}

function applyFields(
  kind: VocabKind,
  node: MdGoal | MdMilestone | MdTask | MdPhase,
  fields: Record<string, unknown>,
): void {
  if (kind === "phase") {
    const p = node as MdPhase;
    if ("name" in fields) p.name = fieldStr(fields, "name");
    if ("status" in fields) p.done = fields.status === "done";
    return;
  }
  if ("title" in fields) (node as MdGoal | MdMilestone | MdTask).title = fieldStr(fields, "title");
  if (kind === "goal" && "objective" in fields)
    (node as MdGoal).objective = fieldStr(fields, "objective");
}

/** A proposal's projected plan, rendered as markdown — `proposals → markdown`. */
export async function proposalMarkdown(changes: ProposalChange[]): Promise<string> {
  return planToMarkdown(applyChangesToTree(await loadPlanTree(), changes));
}

// ── Reconcile edited markdown back into the DB — `markdown → tasks` ─────────────

export type MarkdownApplyResult = {
  created: number;
  updated: number;
  archived: number;
};

/** Apply an edited plan markdown back to the live plan, in one transaction:
 *  - a node with an id that still exists → update its fields + position/parent
 *  - a node with no id → create it (under its parsed parent, at its document order)
 *  - a live node whose id is absent from the markdown → archive it
 *  This is the roundtrip that makes "edit the plan" == "edit the text". */
export async function applyPlanMarkdown(md: string): Promise<MarkdownApplyResult> {
  const parsed = parsePlanMarkdown(md);
  const result: MarkdownApplyResult = { created: 0, updated: 0, archived: 0 };
  const now = new Date();

  await db.transaction(async (tx) => {
    // Every live id, so we can archive the ones the markdown dropped.
    const live = {
      goal: new Set(
        (await tx.select({ id: goals.id }).from(goals).where(isNull(goals.archivedAt))).map(
          (r) => r.id,
        ),
      ),
      milestone: new Set(
        (
          await tx
            .select({ id: milestones.id })
            .from(milestones)
            .where(isNull(milestones.archivedAt))
        ).map((r) => r.id),
      ),
      task: new Set(
        (await tx.select({ id: tasks.id }).from(tasks).where(isNull(tasks.archivedAt))).map(
          (r) => r.id,
        ),
      ),
      phase: new Set(
        (await tx.select({ id: phases.id }).from(phases).where(isNull(phases.archivedAt))).map(
          (r) => r.id,
        ),
      ),
    };
    const kept = {
      goal: new Set<number>(),
      milestone: new Set<number>(),
      task: new Set<number>(),
      phase: new Set<number>(),
    };

    for (const [gi, g] of parsed.goals.entries()) {
      const goalId = await upsertGoal(tx, g, now, result);
      kept.goal.add(goalId);
      for (const [mi, m] of g.milestones.entries()) {
        const milestoneId = await upsertChild(
          tx,
          milestones,
          m.id,
          { goalId, title: m.title, position: mi },
          now,
          result,
        );
        kept.milestone.add(milestoneId);
        for (const [ti, t] of m.tasks.entries()) {
          const taskId = await upsertChild(
            tx,
            tasks,
            t.id,
            { milestoneId, title: t.title, position: ti },
            now,
            result,
          );
          kept.task.add(taskId);
          for (const [pi, p] of t.phases.entries()) {
            const phaseId = await upsertChild(
              tx,
              phases,
              p.id,
              { taskId, name: p.name, status: p.done ? "done" : "todo", position: pi },
              now,
              result,
            );
            kept.phase.add(phaseId);
          }
        }
      }
      // `gi` only affects nothing for goals (no position column) — kept for symmetry.
      void gi;
    }

    // Archive any live node the markdown no longer mentions.
    for (const kind of ["phase", "task", "milestone", "goal"] as const) {
      const table = { goal: goals, milestone: milestones, task: tasks, phase: phases }[kind];
      for (const id of live[kind]) {
        if (kept[kind].has(id)) continue;
        await tx.update(table).set({ archivedAt: now, updatedAt: now }).where(eq(table.id, id));
        result.archived++;
      }
    }
  });

  return result;
}

// A goal has no parent/position; update title+objective or insert.
async function upsertGoal(
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle transaction handle.
  tx: any,
  g: MdGoal,
  now: Date,
  result: MarkdownApplyResult,
): Promise<number> {
  if (g.id != null) {
    await tx
      .update(goals)
      .set({ title: g.title, objective: g.objective, updatedAt: now })
      .where(and(eq(goals.id, g.id), isNull(goals.archivedAt)));
    result.updated++;
    return g.id;
  }
  const [row] = await tx
    .insert(goals)
    .values({ title: g.title, objective: g.objective })
    .returning({ id: goals.id });
  result.created++;
  return row.id;
}

// A milestone/task/phase: update its fields + position (and parent FK) or insert.
async function upsertChild(
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle transaction handle + heterogeneous table.
  tx: any,
  // biome-ignore lint/suspicious/noExplicitAny: one of milestones/tasks/phases.
  table: any,
  id: number | undefined,
  values: Record<string, unknown>,
  now: Date,
  result: MarkdownApplyResult,
): Promise<number> {
  if (id != null) {
    await tx
      .update(table)
      .set({ ...values, updatedAt: now })
      .where(and(eq(table.id, id), isNull(table.archivedAt)));
    result.updated++;
    return id;
  }
  const [row] = await tx.insert(table).values(values).returning({ id: table.id });
  result.created++;
  return row.id;
}
