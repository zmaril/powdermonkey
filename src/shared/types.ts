// Status enums shared between server and browser. The row types (Goal, Milestone,
// Task, Phase, Session) are derived from the Drizzle tables — see schema.ts.

export type PhaseStatus = "todo" | "done";

export type TaskStatus = "pending" | "dispatched" | "merged";

/**
 * Runtime state of a `claude --remote` session.
 * `waiting` is the "Try Again" state — inference finished, the session is parked
 * waiting to resume; Playwright is what reads this back and (later) re-clicks it.
 * `stopped` is a session the operator aborted (see POST /sessions/:id/stop) — a
 * terminal state, distinct from `idle` (a landed/finished session).
 */
export type SessionState = "running" | "waiting" | "idle" | "stopped";

/** Where a session executes: a local git worktree, or a cloud `claude --remote` run. */
export type SessionKind = "local" | "remote";
