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

/**
 * Who made the latest *major decision* on a task/phase — the provenance behind a
 * terminal call (completed, cancelled, reopened), kept apart from the `status`
 * axis that says *what* the decision was. `status` is the what; `decision_source`
 * is the who.
 *
 * - `Reconciled` — the call came from `main`: the reconciler saw a
 *   `PM-Phase:`/`PM-Task:` trailer land (work earned the truth). Written only by
 *   the reconciler; never set by hand.
 * - `Operator` — you made the call by hand in the UI (mark done, close as
 *   won't-do, reopen) for work that never produced a trailer.
 * - `Supervisor` — you delegated the call to the supervisor agent and it acted
 *   through the API on your behalf.
 *
 * `null` on a row that hasn't had a major decision recorded yet. The split keeps
 * an asserted call first-class but visibly distinct from one that landed on
 * `main`, and distinguishes a by-hand call from a delegated one — see
 * docs/completion-model.md.
 */
export const DecisionSource = {
  Reconciled: "reconciled",
  Operator: "operator",
  Supervisor: "supervisor",
} as const;
export type DecisionSource = ValueOf<typeof DecisionSource>;

/** The two human-driven decision sources (everything except `reconciled`, which
 *  is reserved for the reconciler). This is the set the complete/cancel/reopen
 *  endpoints accept as an explicit `source`. */
export const OverrideSource = {
  Operator: DecisionSource.Operator,
  Supervisor: DecisionSource.Supervisor,
} as const;
export type OverrideSource = ValueOf<typeof OverrideSource>;

/**
 * A task's lifecycle. `Pending`/`Dispatched`/`Merged` are the happy path;
 * `Cancelled` is the won't-do terminal state — the task is closed without being
 * finished, so it never counts as done in a rollup. Who closed it (operator vs
 * supervisor) is recorded separately in `decision_source`.
 */
export const TaskStatus = {
  Pending: "pending",
  Dispatched: "dispatched",
  Merged: "merged",
  Cancelled: "cancelled",
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

// GitHub PR state, bounded to the values GitHub's GraphQL actually returns. Same
// const-object-is-the-source-of-truth shape as the status enums above, so the rest
// of the code (CloudPr, the pull_requests row, the UI badges) speaks one closed
// vocabulary instead of bare `string`. Stored as text + `$type` (see schema.ts), so
// widening one later is a code change, not a migration.

/** A PR's lifecycle state. */
export const PrState = { Open: "OPEN", Closed: "CLOSED", Merged: "MERGED" } as const;
export type PrState = ValueOf<typeof PrState>;

/** statusCheckRollup state for a PR's head commit — the CI summary. Null (modelled
 *  separately) means the commit has no checks configured. */
export const CheckRollupState = {
  Success: "SUCCESS",
  Failure: "FAILURE",
  Error: "ERROR",
  Pending: "PENDING",
  Expected: "EXPECTED",
} as const;
export type CheckRollupState = ValueOf<typeof CheckRollupState>;

/** GitHub's lazily-computed merge state. `UNKNOWN` means "not yet computed". */
export const MergeableState = {
  Mergeable: "MERGEABLE",
  Conflicting: "CONFLICTING",
  Unknown: "UNKNOWN",
} as const;
export type MergeableState = ValueOf<typeof MergeableState>;

/**
 * A cloud worker's self-reported lifecycle state, parsed from the sticky
 * `<!-- pm:status -->` comment it keeps on its PR. UNLIKE the enums above this is
 * NOT GitHub's own vocabulary — it's authored as free text by the remote worker —
 * so the parser (github-watch.parseStatusComment) is the validation seam: a status
 * word outside this set resolves to null rather than a typed state. Keep these in
 * sync with the status protocol in the powdermonkey skill
 * (.claude/skills/powdermonkey/SKILL.md), which is what tells the worker which words
 * to write. `Blocked` is the one the UI acts on — it drives the needs-you flag on
 * the Active panel.
 */
export const AgentState = {
  Starting: "starting",
  Working: "working",
  Blocked: "blocked",
  Done: "done",
} as const;
export type AgentState = ValueOf<typeof AgentState>;
