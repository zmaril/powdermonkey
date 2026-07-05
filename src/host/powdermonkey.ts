// PowderMonkey as a Nervo host — the first one.
//
// This expresses PowderMonkey's real lifecycles and moves as a `HostContract`: the task,
// phase, and session state machines the app already runs — built with XState, their
// states the shared vocabulary in src/shared/types.ts — and the operator actions that
// drive them (dispatch / start-local / land / complete / cancel / reopen …), each sending
// one event into a machine, with the cost the app meters.
//
// The dependency runs one way: this host imports Nervo (and XState) and PowderMonkey's own
// vocabulary. Nervo imports NEITHER the vocabulary nor Immersion — it never reaches back
// into the plan schema. That seam is what makes Nervo reusable, and it's checked by
// scripts/lint-boundaries.ts. A second host (examples/word-host.ts) drives an entirely
// different domain through the same core.
//
// The state values and keys are written as `TaskStatus.*` / `SessionState.*` members, never
// bare string literals — the enum is the single source of truth (see docs/typed-strings.md).

import { createMachine } from "xstate";
import { defineHost, type HostContract } from "../nervo/index.ts";
import { PhaseStatus, SessionState, TaskStatus, VocabKind } from "../shared/types.ts";

/** The session entity kind. Not a `VocabKind` (sessions live outside the plan tree), so
 *  it's named here — Nervo entity kinds are just strings the host owns. */
const SESSION = "session";

// ── Entity/FSM definitions (XState) ──────────────────────────────────────────
// The lifecycles the app runs today. XState owns the transition table, so an illegal move
// (dispatching an already-merged task) is rejected by the machine, not a hand-rolled guard.

/** A task: pending → dispatched → merged, cancellable while live, and reopenable
 *  (operator override) from a terminal state back to pending. */
const taskMachine = createMachine({
  initial: TaskStatus.Pending,
  states: {
    [TaskStatus.Pending]: {
      on: {
        DISPATCH: TaskStatus.Dispatched,
        START_LOCAL: TaskStatus.Dispatched,
        COMPLETE: TaskStatus.Merged,
        CANCEL: TaskStatus.Cancelled,
      },
    },
    [TaskStatus.Dispatched]: {
      on: { COMPLETE: TaskStatus.Merged, CANCEL: TaskStatus.Cancelled, RETURN: TaskStatus.Pending },
    },
    [TaskStatus.Merged]: { on: { REOPEN: TaskStatus.Pending } },
    [TaskStatus.Cancelled]: { on: { REOPEN: TaskStatus.Pending } },
  },
});

/** A phase: the grain progress is measured at — todo/done, reopenable. */
const phaseMachine = createMachine({
  initial: PhaseStatus.Todo,
  states: {
    [PhaseStatus.Todo]: { on: { COMPLETE: PhaseStatus.Done } },
    [PhaseStatus.Done]: { on: { REOPEN: PhaseStatus.Todo } },
  },
});

/** A `claude --remote` (or local worktree) session: running ↔ waiting ("Try Again"),
 *  landing to idle or aborted to stopped, both terminal. */
const sessionMachine = createMachine({
  initial: SessionState.Running,
  states: {
    [SessionState.Running]: {
      on: { WAIT: SessionState.Waiting, LAND: SessionState.Idle, STOP: SessionState.Stopped },
    },
    [SessionState.Waiting]: {
      on: { RESUME: SessionState.Running, LAND: SessionState.Idle, STOP: SessionState.Stopped },
    },
    [SessionState.Idle]: {},
    [SessionState.Stopped]: {},
  },
});

// ── The action catalog ───────────────────────────────────────────────────────
// Each action sends one event into its entity's machine; XState gates the lifecycle, cost
// specs price the move.

export const powdermonkey: HostContract = defineHost({
  name: "powdermonkey",
  entities: {
    [VocabKind.Task]: taskMachine,
    [VocabKind.Phase]: phaseMachine,
    [SESSION]: sessionMachine,
  },
  actions: [
    {
      id: "dispatch",
      title: "Dispatch remote",
      entity: VocabKind.Task,
      event: "DISPATCH",
      cost: () => ({ unit: "cloud-run", amount: 1 }),
    },
    {
      id: "start-local",
      title: "Start local",
      entity: VocabKind.Task,
      event: "START_LOCAL",
      cost: () => ({ unit: "worktree", amount: 1 }),
    },
    { id: "complete", title: "Mark done", entity: VocabKind.Task, event: "COMPLETE" },
    { id: "cancel", title: "Close as won't-do", entity: VocabKind.Task, event: "CANCEL" },
    { id: "reopen", title: "Reopen", entity: VocabKind.Task, event: "REOPEN" },
    { id: "complete-phase", title: "Mark phase done", entity: VocabKind.Phase, event: "COMPLETE" },
    { id: "reopen-phase", title: "Reopen phase", entity: VocabKind.Phase, event: "REOPEN" },
    { id: "land", title: "Land session", entity: SESSION, event: "LAND" },
    { id: "stop", title: "Stop session", entity: SESSION, event: "STOP" },
  ],
});
