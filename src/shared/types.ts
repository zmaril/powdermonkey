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

/** Who wrote a task-comment line: the operator (the UI's one-line composer) or the
 *  supervisor agent (through the API, e.g. leaving context on a task it's watching).
 *  The same two human-driven voices as OverrideSource — `reconciled` is a decision
 *  provenance, not a speaker, so it can't author a comment. */
export const CommentAuthor = {
  Operator: DecisionSource.Operator,
  Supervisor: DecisionSource.Supervisor,
} as const;
export type CommentAuthor = ValueOf<typeof CommentAuthor>;

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
 * What flavour of work a task is. Purely descriptive — it colors the card and sets
 * authoring expectations, never behaviour (dispatch, reconciliation, and progress
 * are identical across kinds):
 *
 * - `Task` — the default: planned, build-shaped work.
 * - `Bug` — something is wrong and needs fixing. Discovery-first.
 * - `Spike` — a timeboxed investigation whose deliverable is understanding.
 *
 * Kinds deliberately do NOT template phases: discovery-first work (a bug, a spike)
 * can't be pre-canned — such a task usually starts with few or no phases and
 * accrues them (hand-authored or co-pilot-proposed) as the work is understood.
 * See docs/vocabulary.md § Task.
 */
export const TaskKind = { Task: "task", Bug: "bug", Spike: "spike" } as const;
export type TaskKind = ValueOf<typeof TaskKind>;

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

/** Where autosync lands each snapshot (see docs/backups.md, backup-sync.ts):
 *  `off` — disabled; `local` — commit to a durable local branch only; `push` —
 *  commit locally AND push that one branch to origin. Not a PR per change. */
export const SyncMode = { Off: "off", Local: "local", Push: "push" } as const;
export type SyncMode = ValueOf<typeof SyncMode>;

/**
 * Which backend a cloud ("Dispatch remote") launch uses. `ClaudeRemote` is a
 * `claude --remote` run in Anthropic's cloud; `ExeDev` provisions a per-task VM on
 * exe.dev (copy an authed template → clone the repo → run claude in tmux, exposed
 * over ttyd). Chosen in Settings and read by `dispatchTask`; both produce a
 * `SessionKind.Remote` session (the exe.dev one also carries a `vmName` for teardown).
 */
export const DispatchBackend = { ClaudeRemote: "claude-remote", ExeDev: "exe-dev" } as const;
export type DispatchBackend = ValueOf<typeof DispatchBackend>;

/**
 * One row of pm's runtime registry: an env × agent × model the dispatch engine
 * (disponent) can run, sourced live from its offerings table (see GET /offerings,
 * which calls `getDisponent().offerings()` in src/server/exe-dev.ts). `isDefault`
 * marks the pick for a dispatch that names only the environment. The Settings
 * dispatch picker is driven from this registry instead of hardcoded backend
 * literals — see docs/agents-and-models.md for where the full env × agent ×
 * model × effort model is headed. What each environment can *do* (as opposed to
 * what it can *run*) is a sibling registry — see `EnvCapability` below.
 */
export type Offering = {
  envSlug: string;
  agentName: string;
  modelId: string;
  isDefault: boolean;
};

/**
 * One row of pm's per-env capability registry: something a dispatch environment
 * can do, sourced live from disponent's `env_capabilities` edge (see GET
 * /capabilities, which calls `capabilities()` in src/server/disponent.ts).
 * `capability` is disponent's closed-vocabulary `CapabilityKind` token (e.g.
 * `dispatch`, `observe_poll`, `isolation_worktree`), lowered from the binding's
 * numeric enum to its readable name server-side; `detail` is optional
 * env-specific texture. The Settings dispatch picker shows these per backend so
 * the operator sees what each environment actually supports — honest display,
 * only what disponent advertises.
 */
export type EnvCapability = {
  envSlug: string;
  capability: string;
  detail?: string;
};

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
