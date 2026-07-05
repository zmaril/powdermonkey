// PowderMonkey as a Nervo host — the first one.
//
// This expresses PowderMonkey's real lifecycles and moves as a `HostContract`: the task,
// phase, and session state machines the app already runs (their states are the shared
// vocabulary in src/shared/types.ts), and the operator actions that drive them
// (dispatch / start-local / land / complete / cancel / reopen …), each with the
// permission and cost the app enforces today.
//
// The dependency runs one way: this host imports Nervo and PowderMonkey's own vocabulary.
// Nervo imports NEITHER — it never reaches back into the plan schema. That seam is what
// makes Nervo reusable, and it's checked by scripts/lint-boundaries.ts. A second host
// (examples/word-host.ts) drives an entirely different domain through the same core.

import { defineHost, type Fsm, type HostContract, type Permit } from "../nervo/index.ts";
import { PhaseStatus, SessionState, TaskStatus, VocabKind } from "../shared/types.ts";

/** The session entity kind. Not a `VocabKind` (sessions live outside the plan tree), so
 *  it's named here — Nervo entity kinds are just strings the host owns. */
const SESSION = "session";

// ── Entity/FSM definitions ───────────────────────────────────────────────────
// The lifecycles the app runs today, transcribed as transition maps.

/** A task: pending → dispatched → merged, cancellable from either live state, and
 *  reopenable (operator override) from a terminal one back to pending. */
const taskFsm: Fsm = {
  initial: TaskStatus.Pending,
  transitions: {
    [TaskStatus.Pending]: [TaskStatus.Dispatched, TaskStatus.Cancelled],
    [TaskStatus.Dispatched]: [TaskStatus.Merged, TaskStatus.Cancelled, TaskStatus.Pending],
    [TaskStatus.Merged]: [TaskStatus.Pending],
    [TaskStatus.Cancelled]: [TaskStatus.Pending],
  },
};

/** A phase: the grain progress is measured at — todo/done, reopenable. */
const phaseFsm: Fsm = {
  initial: PhaseStatus.Todo,
  transitions: {
    [PhaseStatus.Todo]: [PhaseStatus.Done],
    [PhaseStatus.Done]: [PhaseStatus.Todo],
  },
};

/** A `claude --remote` (or local worktree) session: running ↔ waiting ("Try Again"),
 *  landing to idle or aborted to stopped, both terminal. */
const sessionFsm: Fsm = {
  initial: SessionState.Running,
  transitions: {
    [SessionState.Running]: [SessionState.Waiting, SessionState.Idle, SessionState.Stopped],
    [SessionState.Waiting]: [SessionState.Running, SessionState.Idle, SessionState.Stopped],
    [SessionState.Idle]: [],
    [SessionState.Stopped]: [],
  },
};

// ── Permission specs ─────────────────────────────────────────────────────────

const onlyFrom =
  (states: string[], reason: string) =>
  ({ entity }: { entity: { state: string } }): Permit =>
    states.includes(entity.state) ? { ok: true } : { ok: false, reason };

const notFrom =
  (states: string[], reason: string) =>
  ({ entity }: { entity: { state: string } }): Permit =>
    states.includes(entity.state) ? { ok: false, reason } : { ok: true };

// ── The action catalog ───────────────────────────────────────────────────────

export const powdermonkey: HostContract = defineHost({
  name: "powdermonkey",
  entities: { [VocabKind.Task]: taskFsm, [VocabKind.Phase]: phaseFsm, [SESSION]: sessionFsm },
  actions: [
    {
      id: "dispatch",
      title: "Dispatch remote",
      entity: VocabKind.Task,
      permit: onlyFrom([TaskStatus.Pending], "only a pending task can be dispatched"),
      cost: () => ({ unit: "cloud-run", amount: 1 }),
      target: () => TaskStatus.Dispatched,
    },
    {
      id: "start-local",
      title: "Start local",
      entity: VocabKind.Task,
      permit: onlyFrom([TaskStatus.Pending], "only a pending task can be started"),
      cost: () => ({ unit: "worktree", amount: 1 }),
      target: () => TaskStatus.Dispatched,
    },
    {
      id: "complete",
      title: "Mark done",
      entity: VocabKind.Task,
      permit: notFrom([TaskStatus.Merged, TaskStatus.Cancelled], "task is already closed"),
      target: () => TaskStatus.Merged,
    },
    {
      id: "cancel",
      title: "Close as won't-do",
      entity: VocabKind.Task,
      permit: notFrom([TaskStatus.Cancelled], "task is already cancelled"),
      target: () => TaskStatus.Cancelled,
    },
    {
      id: "reopen",
      title: "Reopen",
      entity: VocabKind.Task,
      permit: onlyFrom([TaskStatus.Merged, TaskStatus.Cancelled], "only a closed task can reopen"),
      target: () => TaskStatus.Pending,
    },
    {
      id: "complete-phase",
      title: "Mark phase done",
      entity: VocabKind.Phase,
      permit: onlyFrom([PhaseStatus.Todo], "phase is already done"),
      target: () => PhaseStatus.Done,
    },
    {
      id: "reopen-phase",
      title: "Reopen phase",
      entity: VocabKind.Phase,
      permit: onlyFrom([PhaseStatus.Done], "phase is not done"),
      target: () => PhaseStatus.Todo,
    },
    {
      id: "land",
      title: "Land session",
      entity: SESSION,
      permit: onlyFrom(
        [SessionState.Running, SessionState.Waiting],
        "only a live session can land",
      ),
      target: () => SessionState.Idle,
    },
    {
      id: "stop",
      title: "Stop session",
      entity: SESSION,
      permit: onlyFrom([SessionState.Running, SessionState.Waiting], "session is already terminal"),
      target: () => SessionState.Stopped,
    },
  ],
});
