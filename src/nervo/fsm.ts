// Nervo — the finite-state-machine engine.
//
// An entity kind's lifecycle is a plain transition map: each state lists the states
// it may move to. A state with no outgoing edges is terminal. The engine is pure and
// domain-agnostic — it knows nothing about tasks, documents, or any host vocabulary;
// the *values* of the states are strings the host supplies (see contract.ts). This is
// the "entity/FSM definitions" half of the host interface Nervo consumes.

/** One entity kind's state machine: `initial`, and for each state the states it may
 *  transition to. A state whose edge list is empty (or absent) is terminal. */
export type Fsm = {
  initial: string;
  transitions: Record<string, readonly string[]>;
};

/** Every state named in the machine (the keys of the transition map). */
export function states(fsm: Fsm): string[] {
  return Object.keys(fsm.transitions);
}

/** Is `from → to` an allowed edge? Unknown states answer `false` rather than throw —
 *  the engine treats an undeclared state as having no outgoing edges. */
export function canTransition(fsm: Fsm, from: string, to: string): boolean {
  return (fsm.transitions[from] ?? []).includes(to);
}

/** A state with no outgoing edges — the machine can't leave it. */
export function isTerminal(fsm: Fsm, state: string): boolean {
  return (fsm.transitions[state] ?? []).length === 0;
}

/** Take an edge, or throw if it isn't allowed. Returns the destination state so it can
 *  be used inline. The command bus (bus.ts) guards with `canTransition` first, so this
 *  throwing form is for callers that have already validated the move. */
export function transition(fsm: Fsm, from: string, to: string): string {
  if (!canTransition(fsm, from, to)) {
    throw new Error(`illegal transition ${from} → ${to}`);
  }
  return to;
}
