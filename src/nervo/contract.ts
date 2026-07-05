// Nervo — the host interface.
//
// A *host* is a domain (PowderMonkey's plan, a Word document, …) that Nervo drives. It
// supplies three things and gets a headless agentic core in return:
//
//   1. entity/FSM definitions — an XState machine per entity kind (fsm.ts)
//   2. an action catalog      — the typed, permissioned, costed moves Nervo dispatches,
//                               each of which sends one event into an entity's machine
//   3. cost/permission specs   — attached per action, so the core can refuse or price a
//                                move without knowing what the move *means*
//
// Nervo imports neither Immersion (the presentation) nor any host's schema — the seam
// runs one way: hosts depend inward on Nervo, never the reverse. This file is that seam
// expressed as types. See docs/layers.md.

import type { Fsm } from "./fsm.ts";

/** A live entity the core operates on: which kind it is, which one, and its state.
 *  Ids are host-owned (integers in PowderMonkey, could be anything) — Nervo only
 *  reads them back on the transactions it emits. */
export type Entity = {
  kind: string;
  id: string | number;
  state: string;
};

/** What an action is handed when the core evaluates it: the target entity and the
 *  action's parameters (host-typed, opaque to the core). */
export type ActionContext<P = unknown> = {
  entity: Entity;
  params: P;
};

/** Whether an action may fire, beyond what the FSM already enforces. A refusal carries a
 *  human reason the shell can surface — this is the "permission spec" a host attaches to
 *  an action for guards the lifecycle can't express (a budget, a param check). Lifecycle
 *  gating itself is the machine's job, not a permit's. */
export type Permit = { ok: true } | { ok: false; reason: string };

/** An action's price, in whatever unit the host meters (a cloud run, a worktree, a
 *  token budget). The core never interprets the unit — it just records and totals it,
 *  so a host or shell can budget. This is the "cost spec". */
export type Cost = { unit: string; amount: number };

/** One entry in a host's action catalog: a named move against one entity kind that sends
 *  one `event` into that kind's machine, with an optional permission guard and cost. The
 *  core owns dispatch (bus.ts) — resolving the event, checking the permit, pricing the
 *  cost, and letting XState decide whether the event is legal from the current state — so
 *  a host describes moves declaratively and never wires the plumbing itself. */
export type ActionSpec<P = unknown> = {
  /** Stable id the shell and command bus reference. */
  id: string;
  /** Human label for the co-pilot / action menu. */
  title: string;
  /** The entity kind this action targets; must be a key of the host's `entities`. */
  entity: string;
  /** The XState event this action sends. A function form can pick the event from params. */
  event: string | ((ctx: ActionContext<P>) => string);
  /** Permission spec: an extra guard beyond the FSM. Defaults to always-allowed. */
  permit?: (ctx: ActionContext<P>) => Permit;
  /** Cost spec: what does running it cost? Defaults to zero when omitted. */
  cost?: (ctx: ActionContext<P>) => Cost;
};

/** The whole host interface: a name, an XState machine per entity kind, and the action
 *  catalog. This is what `POST`s a domain into Nervo. */
export type HostContract = {
  name: string;
  entities: Record<string, Fsm>;
  actions: readonly ActionSpec[];
};

/** Identity helper that pins a host's shape at definition without widening it. Purely
 *  ergonomic — a host can also write a bare object literal typed as `HostContract`. */
export function defineHost(host: HostContract): HostContract {
  return host;
}
