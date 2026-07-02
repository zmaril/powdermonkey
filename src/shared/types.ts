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
 * A cloud worker's self-reported lifecycle state, parsed from the newest
 * `<!-- pm:status -->`-marked comment it posts on its PR. UNLIKE the enums above this is
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

/**
 * Lifecycle of a plan proposal — a pending change-set the operator decides on.
 * `Pending` awaits a decision; `Approved` was accepted but not yet applied;
 * `Rejected` was declined; `Applied` has been folded into the live plan (terminal,
 * makes re-apply a no-op).
 */
export const ProposalStatus = {
  Pending: "pending",
  Approved: "approved",
  Rejected: "rejected",
  Applied: "applied",
} as const;
export type ProposalStatus = ValueOf<typeof ProposalStatus>;

/** The vocab entities a proposal can mutate. */
export const VocabKind = {
  Goal: "goal",
  Milestone: "milestone",
  Task: "task",
  Phase: "phase",
} as const;
export type VocabKind = ValueOf<typeof VocabKind>;

/** The four kinds of mutation a change-set carries. */
export const ProposalOp = {
  Create: "create",
  Update: "update",
  Archive: "archive",
  Reorder: "reorder",
} as const;
export type ProposalOp = ValueOf<typeof ProposalOp>;

/** An operator's call on a single proposed change (or a create-subtree unit): accept it
 *  (apply immediately) or reject it (drop it). Per-change granularity for inline review. */
export const Decision = {
  Accept: "accept",
  Reject: "reject",
} as const;
export type Decision = ValueOf<typeof Decision>;

/**
 * One typed mutation in a proposal's change-set. Four ops across the four vocab
 * kinds:
 *   - create   a new row. May parent to an existing row (`parentId`) or to a
 *              sibling create in the same proposal (`parentRef`), so a whole new
 *              subtree can be proposed at once. `ref` is the temp handle other
 *              creates point at.
 *   - update   patch fields on an existing row by `id`.
 *   - archive  soft-delete an existing row by `id`.
 *   - reorder  move an existing row: a new `position`, and optionally reparent it
 *              (`parentId` = new goal/milestone/task it hangs under).
 */
export type ProposalChange =
  | {
      op: "create";
      kind: VocabKind;
      ref?: string;
      parentId?: number;
      parentRef?: string;
      fields: Record<string, unknown>;
      position?: number;
    }
  | { op: "update"; kind: VocabKind; id: number; fields: Record<string, unknown> }
  | { op: "archive"; kind: VocabKind; id: number }
  | { op: "reorder"; kind: VocabKind; id: number; position?: number; parentId?: number };

/**
 * One rate-limit window as Claude reports it — a slice of the shared cap the global
 * status bar surfaces. `utilization` is the fraction of the window consumed (0..1, so
 * the bar can render "83%" or a meter without extra math); `resetsAt` is when the
 * window rolls over (epoch ms), or null when the source doesn't give one. `label` is
 * the short window name for the UI ("5h", "7d", or a model's display name).
 */
export type UsageWindow = {
  label: string;
  utilization: number;
  resetsAt: number | null;
};

/**
 * A Claude usage/limits snapshot for the global status bar. Sourced from the
 * operator's local Claude Code OAuth session (see src/server/claude-usage.ts and
 * docs/claude-usage-spike.md): the tier metadata (`subscriptionType`,
 * `rateLimitTier`) is read straight from `~/.claude/.credentials.json` and is almost
 * always present, while the live `windows` come from the `/api/oauth/usage` endpoint
 * and are only populated when the stored access token is still valid.
 *
 * `available` is the honest split the bar renders on: `true` means the live endpoint
 * answered and `windows` is real; `false` means we're degraded (token expired, no
 * credentials, or the endpoint was unreachable) and only the static tier is known —
 * the vocabulary's "as the data is available" made explicit. `reason` explains the
 * degradation for a tooltip; `fetchedAt` (epoch ms) stamps the snapshot so the client
 * can show its age.
 */
export type ClaudeUsage = {
  available: boolean;
  subscriptionType: string | null;
  rateLimitTier: string | null;
  windows: UsageWindow[];
  reason: string | null;
  fetchedAt: number;
};
