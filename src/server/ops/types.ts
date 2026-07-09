import type { Static, TSchema } from "@sinclair/typebox";
import type { db as dbSingleton } from "../db.ts";
import type { getDisponent } from "../exe-dev.ts";

// The op-table: ONE declarative definition of a control operation that projects to
// BOTH surfaces pm exposes.
//
//   - the existing Elysia REST route (browser/Eden — app.ts delegates to op.handler)
//   - a Model Context Protocol tool (mcp.ts registers each op as a tool)
//
// The pivot that makes one definition serve both is the TypeBox `input` schema:
// Elysia validates request bodies against TypeBox natively, and TypeBox schemas ARE
// JSON Schema — exactly what an MCP tool's `inputSchema` needs. So the same schema
// object validates the REST body and describes the MCP tool, with no second copy to
// drift.
//
// The handler is the SINGLE implementation both surfaces invoke. It is deliberately
// transport-agnostic: it takes a validated input and a context, does the work, and
// returns a plain value. HTTP status shaping (404/400) stays in the REST route;
// content wrapping stays in the MCP layer. Neither concern leaks into the op.

/** The ambient process state a handler may need. pm's domain modules (plan.ts,
 *  reconcile.ts, …) reach the store and the disponent engine through module
 *  singletons, so within one process the context and those singletons resolve to
 *  the same store — the supervisor server and a standalone `pm mcp` process each get
 *  their own by construction (each opens its own PGlite writer under its PM_DATA_DIR).
 *  Carrying them here makes that dependency explicit and lets a handler take the
 *  store/engine as arguments rather than reaching for a global. */
export type OpContext = {
  db: typeof dbSingleton;
  disponent: typeof getDisponent;
};

/** One control operation, projected to both the REST route and an MCP tool.
 *  Generic over the input schema `I` and the handler's output `O`: an individual
 *  op constant keeps its precise `O`, so a REST route that delegates to
 *  `someOp.handler(...)` still hands Eden Treaty the exact response type. Collected
 *  into `Op[]` for MCP iteration, `O` widens to `unknown` (the tool serializes it to
 *  JSON regardless). */
export type Op<I extends TSchema = TSchema, O = unknown> = {
  /** Stable identifier — the MCP tool name (e.g. `task.dispatch`). */
  name: string;
  /** Human title for the tool (MCP `title` annotation). */
  title: string;
  /** What the op does — the MCP tool `description` an agent reads to pick it. */
  description: string;
  /** TypeBox schema for the input. Doubles as the MCP tool's JSON-Schema
   *  `inputSchema` and (where wired) the Elysia route's body validator. */
  input: I;
  /** Marks a write that mutates or removes state — surfaced as MCP's
   *  `destructiveHint` so a client can gate/confirm it. Reads omit it. */
  destructive?: boolean;
  /** A pure read (no mutation) — surfaced as MCP's `readOnlyHint`. */
  readOnly?: boolean;
  /** The single shared implementation. Transport-agnostic: validated `input` in,
   *  a plain value out. Throwing surfaces as a 500 (REST) / tool error (MCP).
   *  Declared as a method (not an arrow property) so heterogeneous ops collect into
   *  `Op[]` — the bivariant method check lets a specific input schema stand in for
   *  the erased `TSchema` there, while each exported op constant keeps its precise
   *  input/output types for the REST routes that call it. */
  handler(ctx: OpContext, input: Static<I>): O;
};

/** Narrow a value to an Op, inferring both the input schema and output type at the
 *  definition site so each exported op constant stays precisely typed. */
export function defineOp<I extends TSchema, O>(op: Op<I, O>): Op<I, O> {
  return op;
}
