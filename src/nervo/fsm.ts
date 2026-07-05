// Nervo — the finite-state-machine engine, backed by XState.
//
// An entity kind's lifecycle IS an XState machine (`createMachine`): states, and the
// named events that move between them. The engine is a thin, pure wrapper over XState's
// snapshot API — it computes the next state for an event without ever spinning up an
// actor, so the whole core stays side-effect-free (bus.ts turns a dispatch into a plain
// `Transaction` the caller persists). Nervo depends on XState and nothing else app-side;
// it never reaches into Immersion or a host's schema (scripts/lint-boundaries.ts).
//
// The states are still just strings a host names — a host supplies the machines, Nervo
// steps them. This is the "entity/FSM definitions" half of the host interface.

import { type AnyStateMachine, getInitialSnapshot, getNextSnapshot } from "xstate";

/** An entity kind's state machine — any XState machine. Hosts build these with
 *  `createMachine`; Nervo only ever reads state out of them. */
export type Fsm = AnyStateMachine;

/** The machine's initial state value. */
export function initialState(fsm: Fsm): string {
  return String(getInitialSnapshot(fsm, undefined).value);
}

// The one place Nervo reaches into an XState state node's shape, to read the events a
// state accepts. Kept in a single helper so the (version-sensitive) internal access is
// isolated — everything else goes through XState's public snapshot API.
function acceptedEvents(fsm: Fsm, state: string): string[] {
  // biome-ignore lint/suspicious/noExplicitAny: StateNode.on isn't in the public types.
  const node = (fsm as any).states?.[state];
  return node?.on ? Object.keys(node.on) : [];
}

/** Does `state` accept `event`? False for an unknown state or an unhandled event — the
 *  bus uses this to refuse an illegal move before computing anything. */
export function accepts(fsm: Fsm, state: string, event: string): boolean {
  return acceptedEvents(fsm, state).includes(event);
}

/** The state `event` drives the machine to from `state`. Assumes the move is legal —
 *  the bus guards with `accepts` first. */
export function nextState(fsm: Fsm, state: string, event: string): string {
  // Nervo's machines are context-free lifecycles; XState's snapshot type still wants a
  // `context` key, so pass an empty one.
  const from = fsm.resolveState({ value: state, context: undefined });
  return String(getNextSnapshot(fsm, from, { type: event }).value);
}

/** A state that accepts no events — the machine can't leave it. */
export function isTerminal(fsm: Fsm, state: string): boolean {
  return acceptedEvents(fsm, state).length === 0;
}
