// Nervo — the command bus.
//
// Dispatch is the one door every state change goes through. Given a host, an entity, and
// an action id, the bus: resolves the action, checks it targets the entity's kind,
// resolves the action's event, runs the permission spec, asks XState whether that event
// is legal from the entity's current state, prices the cost spec, and — only if all of
// that holds — emits a `Transaction`: the before/after entities and the cost. It never
// mutates anything; the caller (or history.ts) owns the entity and applies `tx.after`.
// That purity is what makes undo trivial: a transaction already carries its own `before`.

import type { ActionContext, Cost, Entity, HostContract } from "./contract.ts";
import { accepts, nextState } from "./fsm.ts";

/** A validated, priced, not-yet-persisted state change. `before`/`after` are the same
 *  entity either side of the move; `cost` is what the action's cost spec quoted. */
export type Transaction = {
  action: string;
  before: Entity;
  after: Entity;
  cost: Cost;
};

/** Dispatch's outcome: the transaction, or a human reason it was refused (unknown
 *  action, wrong entity kind, denied by the permit, or an event the machine rejects). */
export type DispatchResult = { ok: true; tx: Transaction } | { ok: false; error: string };

const NO_COST: Cost = { unit: "none", amount: 0 };

/** Run one action against one entity. Pure: returns a Transaction, changes nothing. */
export function dispatch(
  host: HostContract,
  entity: Entity,
  actionId: string,
  params: unknown = undefined,
): DispatchResult {
  const action = host.actions.find((a) => a.id === actionId);
  if (!action) return { ok: false, error: `unknown action: ${actionId}` };
  if (action.entity !== entity.kind) {
    return { ok: false, error: `action ${actionId} targets ${action.entity}, not ${entity.kind}` };
  }

  const fsm = host.entities[entity.kind];
  if (!fsm) return { ok: false, error: `no FSM for entity kind: ${entity.kind}` };

  const ctx: ActionContext = { entity, params };

  const permit = action.permit ? action.permit(ctx) : { ok: true as const };
  if (!permit.ok) return { ok: false, error: permit.reason };

  const event = typeof action.event === "function" ? action.event(ctx) : action.event;
  if (!accepts(fsm, entity.state, event)) {
    return { ok: false, error: `illegal move: ${event} not accepted in state ${entity.state}` };
  }

  const cost = action.cost ? action.cost(ctx) : NO_COST;
  const after: Entity = { ...entity, state: nextState(fsm, entity.state, event) };
  return { ok: true, tx: { action: actionId, before: entity, after, cost } };
}

/** The moves that could fire on `entity` right now: every catalogued action for its kind
 *  whose permit passes and whose event the machine accepts from the current state. This is
 *  what a co-pilot pane or action menu renders — the affordances, already filtered by
 *  permission and lifecycle. */
export function available(host: HostContract, entity: Entity): string[] {
  const fsm = host.entities[entity.kind];
  if (!fsm) return [];
  const out: string[] = [];
  for (const action of host.actions) {
    if (action.entity !== entity.kind) continue;
    const ctx: ActionContext = { entity, params: undefined };
    if (action.permit && !action.permit(ctx).ok) continue;
    const event = typeof action.event === "function" ? action.event(ctx) : action.event;
    if (accepts(fsm, entity.state, event)) out.push(action.id);
  }
  return out;
}
