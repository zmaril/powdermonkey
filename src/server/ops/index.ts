import { isNull } from "drizzle-orm";
import { t } from "elysia";
import { OverrideSource } from "../../shared/types.ts";
import { cancelTask, completeTask } from "../completion.ts";
import { db } from "../db.ts";
import { dispatchTask } from "../dispatch.ts";
import { getDisponent } from "../exe-dev.ts";
import { loadPlan, planSchema } from "../plan.ts";
import { listPending } from "../proposals.ts";
import { reconcile } from "../reconcile.ts";
import { tasks } from "../schema.ts";
import { defineOp, type Op, type OpContext } from "./types.ts";

// The op-table — the single source that projects to both of pm's surfaces. Each op
// names the SAME handler the REST route in app.ts delegates to; mcp.ts registers the
// same set as MCP tools. There is no second implementation: the browser (via Eden +
// /sync) and an external MCP client both drive these exact handlers.
//
// The subset here is deliberately focused rather than exhaustive — the high-value
// control ops an external supervising agent most needs (author / run / lifecycle),
// plus two reads — proving the pattern end to end. The full REST surface (see
// notes / the gap table) can be projected the same way incrementally.
//
// The `source` an override op records: an MCP client is the supervisor agent acting
// on the operator's behalf, so these default to `supervisor` (the REST routes keep
// their own `operator` default — behavior on that surface is unchanged).
const sourceInput = t.Optional(
  t.Union([t.Literal(OverrideSource.Operator), t.Literal(OverrideSource.Supervisor)]),
);
function decisionSource(source?: OverrideSource): OverrideSource {
  return source ?? OverrideSource.Supervisor;
}

/** Union the primary task id with any extra ids, primary first, deduped — several
 *  tasks can fold into one session. Mirrors app.ts's `launchIds`. */
function launchIds(taskId: number, extra?: number[]): number[] {
  return [...new Set([taskId, ...(extra ?? [])])];
}

// ── Author ──────────────────────────────────────────────────────────────────

export const planLoad = defineOp({
  name: "plan.load",
  title: "Load a plan",
  description:
    "Load a nested, id-less plan tree (goal → milestones → tasks → phases) in one " +
    "transaction. The loader assigns ids and wires foreign keys; returns per-level counts. " +
    "This is the primary authoring entrypoint.",
  input: planSchema,
  handler: (_ctx, input) => loadPlan(input),
});

// ── Run ─────────────────────────────────────────────────────────────────────

export const taskDispatch = defineOp({
  name: "task.dispatch",
  title: "Dispatch a task to the cloud",
  description:
    "Dispatch one or more tasks as a SINGLE cloud session (the operator-chosen backend) " +
    "against main. Pass extra `taskIds` to fold several tasks into the one session (they " +
    "must target the same repo). Returns the session URL and row, or an honest failure " +
    "(e.g. no GitHub repo resolved, cross-repo selection).",
  input: t.Object({
    taskId: t.Number({ description: "The primary task to dispatch." }),
    taskIds: t.Optional(
      t.Array(t.Number(), { description: "Extra tasks to fold into the same session." }),
    ),
    comment: t.Optional(
      t.String({ description: "Operator note for this run, appended to the worker brief." }),
    ),
  }),
  destructive: false,
  handler: (_ctx, input) => dispatchTask(launchIds(input.taskId, input.taskIds), input.comment),
});

// ── Lifecycle overrides ───────────────────────────────────────────────────────

export const taskComplete = defineOp({
  name: "task.complete",
  title: "Complete a task",
  description:
    "Override-complete a task: close every still-todo phase and roll the task to `merged`. " +
    "The out-of-band completion for work that never landed a PM-Task/PM-Phase trailer. " +
    "Never touches reconciled rows (those belong to main). Stamps decision provenance.",
  input: t.Object({
    taskId: t.Number(),
    source: sourceInput,
  }),
  destructive: false,
  handler: (_ctx, input) => completeTask(input.taskId, decisionSource(input.source)),
});

export const taskCancel = defineOp({
  name: "task.cancel",
  title: "Cancel a task",
  description:
    "Cancel a task as won't-do: it goes to `cancelled` and is archived (soft-deleted), " +
    "leaving the live panes. Terminal but not done — a cancelled task never counts toward " +
    "progress. Records who made the call.",
  input: t.Object({
    taskId: t.Number(),
    source: sourceInput,
  }),
  destructive: true,
  handler: (_ctx, input) => cancelTask(input.taskId, decisionSource(input.source)),
});

export const reconcileOp = defineOp({
  name: "reconcile",
  title: "Reconcile progress from main",
  description:
    "Scan the commits reachable from main for PM-Phase / PM-Task trailers and tick the " +
    "matching phases/tasks, rolling finished tasks to `merged` and archiving finished " +
    "sessions. Idempotent — safe to call any time. Returns counts of what changed.",
  input: t.Object({}),
  handler: () => reconcile(),
});

// ── Reads ─────────────────────────────────────────────────────────────────────

export const tasksList = defineOp({
  name: "tasks.list",
  title: "List tasks",
  description:
    "List tasks. By default only live (non-archived) tasks; pass `archived: true` to " +
    "include archived/cancelled ones. Reads the same tasks table the REST GET /tasks " +
    "route serves.",
  input: t.Object({
    archived: t.Optional(
      t.Boolean({ description: "Include archived (cancelled/soft-deleted) tasks." }),
    ),
  }),
  readOnly: true,
  // Read straight off the shared context's store — the same rows the REST list route
  // (crud.list) returns for /tasks, driven here from the injected db handle.
  handler: (ctx, input) => {
    const q = ctx.db.select().from(tasks);
    return input.archived ? q : q.where(isNull(tasks.archivedAt));
  },
});

export const proposalsPending = defineOp({
  name: "proposals.pending",
  title: "List pending proposals",
  description:
    "List the operator's pending decision queue — proposals a supervisor authored that " +
    "await approve/reject/apply. The supervisor↔operator loop's read side.",
  input: t.Object({}),
  readOnly: true,
  handler: () => listPending(),
});

/** The op-table, in a stable order (author → run → lifecycle → read). */
export const ops: Op[] = [
  planLoad,
  taskDispatch,
  taskComplete,
  taskCancel,
  reconcileOp,
  tasksList,
  proposalsPending,
];

/** Ops keyed by name, for the REST routes that delegate to a specific op. */
export const opsByName: Record<string, Op> = Object.fromEntries(ops.map((op) => [op.name, op]));

/** Build the shared context both surfaces hand to a handler. Within one process the
 *  db + disponent singletons are the store/engine every domain module already uses,
 *  so a handler invoked from REST and the same handler invoked from `pm mcp` operate
 *  on that process's store. */
export function buildContext(): OpContext {
  return { db, disponent: getDisponent };
}
