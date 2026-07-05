// Nervo — the headless agentic core, as a single import surface.
//
// Nervo is domain-agnostic: it drives entity lifecycles (FSM engine), dispatches typed,
// permissioned, costed actions (command bus), records reversible history (undo), and
// models pending change-sets (proposals) — all against a `HostContract` a host supplies.
// It depends on nothing app-specific: not Immersion (the shell), not any host's schema.
// That one-way seam is enforced by scripts/lint-boundaries.ts. See docs/layers.md.

export type { DispatchResult, Transaction } from "./bus.ts";
export { available, dispatch } from "./bus.ts";
export type { ActionContext, ActionSpec, Cost, Entity, HostContract, Permit } from "./contract.ts";
export { defineHost } from "./contract.ts";
export type { Fsm } from "./fsm.ts";
export { canTransition, isTerminal, states, transition } from "./fsm.ts";
export { History } from "./history.ts";
export type { Change, Proposal } from "./proposals.ts";
export { ChangeOp, decide, unitIndices } from "./proposals.ts";
