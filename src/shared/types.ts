// Status enums shared between server and browser. Each is a const object that is
// the single source of truth for both its runtime values and its type — the union
// is derived from the object, so there's exactly one place to add/rename a state.
// The string values are the on-the-wire / in-DB representation (see schema.ts,
// whose columns are `$type<…>()`-constrained to these unions); the row types
// (Goal, Milestone, Task, Phase, Session) are derived from the Drizzle tables.

// `(typeof X)[keyof typeof X]` collapses a const object to the union of its values.
type ValueOf<T> = T[keyof T];

export const PhaseStatus = { Todo: "todo", Done: "done" } as const;
export type PhaseStatus = ValueOf<typeof PhaseStatus>;

export const TaskStatus = {
  Pending: "pending",
  Dispatched: "dispatched",
  Merged: "merged",
} as const;
export type TaskStatus = ValueOf<typeof TaskStatus>;

/**
 * Runtime state of a `claude --remote` session.
 * `Waiting` is the "Try Again" state — inference finished, the session is parked
 * waiting to resume; Playwright is what reads this back and (later) re-clicks it.
 * `Stopped` is a session the operator aborted (see POST /sessions/:id/stop) — a
 * terminal state, distinct from `Idle` (a landed/finished session).
 */
export const SessionState = {
  Running: "running",
  Waiting: "waiting",
  Idle: "idle",
  Stopped: "stopped",
} as const;
export type SessionState = ValueOf<typeof SessionState>;

/** Where a session executes: a local git worktree, or a cloud `claude --remote` run. */
export const SessionKind = { Local: "local", Remote: "remote" } as const;
export type SessionKind = ValueOf<typeof SessionKind>;
