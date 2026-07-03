import {
  bigint,
  boolean,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import {
  type AgentState,
  type CheckRollupState,
  CommentAuthor,
  type DecisionSource,
  type MergeableState,
  PhaseStatus,
  type ProposalChange,
  ProposalStatus,
  type PrState,
  SessionKind,
  SessionState,
  TaskKind,
  TaskStatus,
} from "../shared/types.ts";

// The plan vocabulary, fully normalized: every entity is its own relation with an
// auto-assigned integer id and an `archived_at` soft-delete column (null = live).
// goals → milestones → tasks → phases; sessions are independent.

// Shared columns every relation carries.
const timestamps = {
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  // Soft delete: when set, the row is archived and excluded from default lists.
  archivedAt: timestamp("archived_at"),
};

export const goals = pgTable("goals", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  title: text("title").notNull(),
  objective: text("objective").notNull().default(""),
  // A default repo the goal's tasks inherit unless overridden lower down. The planning
  // spine stays repo-agnostic (a goal can span repos), but a goal scoped to one repo
  // pre-fills every task under it — the plan loader cascades this to a repo-less task,
  // and the fan-out picker seeds from it. Nullable: most goals declare none. See
  // docs/vocabulary.md § Goal.
  repoId: integer("repo_id").references(() => repos.id),
  ...timestamps,
});

export const milestones = pgTable("milestones", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  goalId: integer("goal_id")
    .notNull()
    .references(() => goals.id),
  title: text("title").notNull(),
  position: integer("position").notNull().default(0),
  // A default repo for tasks under this milestone, overriding the goal's. Same
  // inheritance story as goals.repoId, one level down (milestone wins over goal); the
  // task can still override it. Nullable. See docs/vocabulary.md § Milestone.
  repoId: integer("repo_id").references(() => repos.id),
  ...timestamps,
});

export const tasks = pgTable("tasks", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  milestoneId: integer("milestone_id")
    .notNull()
    .references(() => milestones.id),
  // The repo this task runs against — its dispatch environment. A task targets
  // exactly one repo (a session clones one repo); the planning spine above it stays
  // repo-agnostic. Nullable: pre-registry tasks carry none until the boot seed
  // backfills them to the supervisor's own repo. See docs/vocabulary.md.
  repoId: integer("repo_id").references(() => repos.id),
  title: text("title").notNull(),
  // What flavour of work this is (task | bug | spike). Descriptive only — it colors
  // the card and sets authoring expectations, never behaviour. See TaskKind.
  kind: text("kind").$type<TaskKind>().notNull().default(TaskKind.Task),
  // Free-form context: why the task exists, what's known, where it was seen. Kept
  // apart from phases on purpose — phases stay pure work steps (the grain progress
  // is measured at), the description carries the narrative. Null = none.
  description: text("description"),
  position: integer("position").notNull().default(0),
  // Operator priority: a starred task sorts to the top of its group (active/backlog).
  starred: boolean("starred").notNull().default(false),
  // Progress is set during reconciliation when a PR merges, never self-reported.
  status: text("status").$type<TaskStatus>().notNull().default(TaskStatus.Pending),
  // Who made the latest major decision on this task — `reconciled` (a trailer
  // landed on `main`), `operator` (closed/reopened by hand), or `supervisor`
  // (delegated to the supervisor agent). Null until a major decision is recorded.
  // Kept apart from `status` (the what vs the who) — see docs/completion-model.md.
  decisionSource: text("decision_source").$type<DecisionSource>(),
  // Runtime session fields (a session is attached to the task it was dispatched
  // for; sessions can also exist independently in the sessions table).
  sessionUrl: text("session_url"),
  sessionState: text("session_state").$type<SessionState>(),
  prUrl: text("pr_url"),
  ...timestamps,
});

export const phases = pgTable("phases", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  taskId: integer("task_id")
    .notNull()
    .references(() => tasks.id),
  name: text("name").notNull(),
  status: text("status").$type<PhaseStatus>().notNull().default(PhaseStatus.Todo),
  // Who completed this phase (`reconciled` | `operator` | `supervisor`), null
  // while todo — the phase-grain twin of tasks.decisionSource. See
  // docs/completion-model.md.
  decisionSource: text("decision_source").$type<DecisionSource>(),
  position: integer("position").notNull().default(0),
  ...timestamps,
});

// One run of work. Independent of the hierarchy — a session may pull work from
// multiple goals at once. Created at runtime, never authored. A `local` session
// executes in a git worktree on `branch`; a `remote` one is a `claude --remote`
// run reachable at `url`. The tasks a session is working sit in the session_tasks
// join below (a single session can be dispatched for several tasks at once).
export const sessions = pgTable("sessions", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  kind: text("kind").$type<SessionKind>().notNull().default(SessionKind.Local),
  state: text("state").$type<SessionState>().notNull().default(SessionState.Running),
  branch: text("branch"),
  worktreePath: text("worktree_path"),
  url: text("url"),
  // A local session runs an interactive `claude` PTY in its worktree. When that
  // process falls idle after producing output, it's read as "parked at a prompt,
  // waiting for the operator" and surfaced here so the UI can pull them in.
  needsInput: boolean("needs_input").notNull().default(false),
  ...timestamps,
});

// Which tasks a session is working. A session can be dispatched for several tasks
// at once (one worker, one combined brief), and each task surfaces the shared
// session — so the link is many-to-many rather than a single sessions.task_id.
// Liveness is the session's, not the link's: a link counts as active only while
// its session row is live (non-archived), so there's no archived_at here.
export const sessionTasks = pgTable("session_tasks", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  sessionId: integer("session_id")
    .notNull()
    .references(() => sessions.id),
  taskId: integer("task_id")
    .notNull()
    .references(() => tasks.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// A task's diary: one-line comments muttered onto a task — by the operator (the
// card's composer) or the supervisor agent (via the API). Capture stays
// zero-ceremony (one line, auto-timestamped), but a line is an ordinary row after
// that: it can be edited in place (fix the typo) and archived (soft delete, like
// every other entity), carrying the shared timestamps.
export const taskComments = pgTable("task_comments", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  taskId: integer("task_id")
    .notNull()
    .references(() => tasks.id),
  // Who wrote the line — operator or supervisor (see CommentAuthor).
  author: text("author").$type<CommentAuthor>().notNull().default(CommentAuthor.Operator),
  body: text("body").notNull(),
  ...timestamps,
});

// The repo registry: a flat, global list of the GitHub repos the operator drives.
// A Repo is *where* work runs, kept apart from the *what* (the goal→…→task spine) —
// only a Task pins one (its dispatch environment). Cloud-first: the repo of record
// is on GitHub (`owner/name`); PowderMonkey clones a transient cache on demand and
// never treats it as a checkout you browse. See docs/vocabulary.md.
export const repos = pgTable("repos", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  // The GitHub identity of record, "owner/name". The natural key of a repo; the
  // boot seed and the picker find-or-create by it (no DB unique constraint, so an
  // archived row can be re-added — callers dedupe on the live set).
  slug: text("slug").notNull(),
  owner: text("owner").notNull(),
  name: text("name").notNull(),
  // The branch reconciliation scans and sessions cut from. Defaults to main.
  defaultBranch: text("default_branch").notNull().default("main"),
  // The repo's homepage (`gh repo view --json homepageUrl`), used to resolve a
  // favicon; null when it has none.
  homepageUrl: text("homepage_url"),
  // Fork-first provenance: the upstream slug this was forked from, so cloud dispatch
  // can push to the operator's fork while tracking the source. Null for an owned repo.
  upstream: text("upstream"),
  // A stable seed for the repo's swatch, resolved to a hue in the *active* theme's
  // palette (re-skins on theme change). Null means "derive from the slug"; an operator
  // override stores an explicit seed here.
  colorSeed: text("color_seed"),
  // Cached icon under ~/.powdermonkey/repos/.icons/<owner>/<name>.png (favicon,
  // else owner avatar — see repo-icon.ts), served at /repos/:id/icon. Null until
  // resolved (lazily, on the first icon request).
  iconPath: text("icon_path"),
  ...timestamps,
});

// Operator notepad. Free-form notes the operator keeps alongside the plan —
// scratch thoughts, reminders, context for the supervisor. Not part of the
// goal hierarchy; the supervisor reads them on request (e.g. "check @notes").
export const notes = pgTable("notes", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  title: text("title").notNull().default(""),
  body: text("body").notNull().default(""),
  position: integer("position").notNull().default(0),
  ...timestamps,
});

// Persisted PR state — the durable mirror of what github-watch polls from GitHub,
// plus the rebase-ask ledger. Two kinds of data live here with deliberately
// different lifetimes:
//   • Observed GitHub state (state / checks / mergeable / …) is a *cache*. GitHub
//     is the source of truth and we refetch every tick, so these columns are
//     overwritten freely; persisting them only buys cold-start UI and history.
//   • `rebaseAskedAt` is a *ledger of a side-effect we performed* — the @claude
//     rebase comment. It must survive restarts so we never re-ask the same
//     conflict. The poll upsert rewrites the cache columns and never touches this
//     one; only the ask logic (github-watch) writes it. That split is the whole
//     reason the two can share a row safely.
// Keyed by (repo, number) — both supplied by us, not generated. A GitHub PR number
// is only unique within its repo, and the watcher polls every registered repo.
export const pullRequests = pgTable(
  "pull_requests",
  {
    // The GitHub repo the PR lives in, as its "owner/name" slug. A plain string,
    // *not* an FK into `repos`: rows must survive a repo being archived or re-added
    // (they're a cache + a ledger, not part of the registry).
    repo: text("repo").notNull(),
    number: integer("number").notNull(),
    // The task this PR is tied to, resolved by the watcher from the branch name or
    // commit trailers. Plain integer, *not* a FK: a branch like `pm/task-166` yields
    // 166 whether or not that task row exists locally, and persistence must not throw
    // on the mismatch.
    taskId: integer("task_id").notNull(),
    title: text("title").notNull().default(""),
    url: text("url").notNull(),
    state: text("state").$type<PrState>().notNull(),
    isDraft: boolean("is_draft").notNull().default(false),
    merged: boolean("merged").notNull().default(false), // lint-allow-string: DB column name
    // statusCheckRollup state (SUCCESS / FAILURE / PENDING / …), null when none.
    checks: text("checks").$type<CheckRollupState>(),
    // MERGEABLE / CONFLICTING / UNKNOWN, or null — GitHub computes it lazily.
    mergeable: text("mergeable").$type<MergeableState>(),
    headRefName: text("head_ref_name").notNull(),
    // GitHub's own PR updatedAt (ISO string). Named apart from the row's `updatedAt`
    // below, which tracks when *we* last wrote the row.
    ghUpdatedAt: text("gh_updated_at").notNull(),
    // The worker's self-reported status, parsed from its newest `<!-- pm:status -->`-marked
    // PR comment (see github-watch.parseStatusComment + the powdermonkey skill). Cache
    // columns like the GitHub state above — overwritten every tick, null when the PR
    // has no status comment. `agentState` is the typed lifecycle (AgentState) or null
    // for an unrecognised word; `agentBody` is the raw comment kept for the UI's
    // human-readable glance; `agentUpdatedAt` is the comment's GitHub edit time.
    agentState: text("agent_state").$type<AgentState>(),
    agentSummary: text("agent_summary"),
    agentNext: text("agent_next"),
    // The cloud session that authored the status comment (the worker-stamped
    // `claude.ai/code/…` link) — a direct PR→session map, see events.ts AgentStatus.
    agentSessionUrl: text("agent_session_url"),
    agentBody: text("agent_body"),
    agentUpdatedAt: text("agent_updated_at"),
    // The agent's newest PR comment (footer/marker stripped) — shown live on the worker
    // card. Cache column like the rest; overwritten each poll, null until it speaks.
    lastComment: text("last_comment"),
    lastCommentAt: text("last_comment_at"),
    lastCommentUrl: text("last_comment_url"),
    // The ledger: when set, we've already asked @claude to rebase this conflict
    // episode; cleared when the PR goes MERGEABLE (or leaves the board) so a later,
    // distinct conflict re-asks. Survives restarts — that's the point of this table.
    rebaseAskedAt: timestamp("rebase_asked_at"),
    ...timestamps,
  },
  (t) => ({ pk: primaryKey({ columns: [t.repo, t.number] }) }),
);

// Operator runtime settings — a single-row table (id always 1) of toggles that
// should survive a restart. Starts with just `autoRebase` (whether the watcher
// auto-asks @claude to rebase a conflicting PR); add columns as more settings appear.
export const settings = pgTable("settings", {
  id: integer("id").primaryKey().default(1),
  autoRebase: boolean("auto_rebase").notNull().default(true),
  ...timestamps,
});

// A proposal: a pending change-set of typed vocab mutations the operator decides
// on before it touches the live plan. The supervisor/agent authors one when it is
// SUGGESTING a change (rather than direct CRUD for a just-do-it edit); the operator
// reviews it — rendered as markdown — and approves or rejects it.
//
// `changes` is the ordered list of typed mutations (create/update/archive/reorder
// across goals·milestones·tasks·phases). `base` is a snapshot of the updated_at of
// every existing row the change-set touches, captured at authoring time — the apply
// engine compares it against the live rows to detect a stale base (the plan moved
// under the proposal) and refuse to clobber. `status` walks pending → approved →
// applied (or → rejected); `applied_at` stamps the terminal apply so re-apply is a
// no-op.
export const proposals = pgTable("proposals", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  title: text("title").notNull().default(""),
  summary: text("summary").notNull().default(""),
  status: text("status").$type<ProposalStatus>().notNull().default(ProposalStatus.Pending),
  changes: jsonb("changes").$type<ProposalChange[]>().notNull(),
  base: jsonb("base").$type<Record<string, string>>().notNull(),
  appliedAt: timestamp("applied_at"),
  // Follow-up provenance: set when a proposal was authored by a worker handing back
  // an out-of-scope find (rather than the operator/supervisor proposing a plan edit).
  // All nullable — a normal plan-edit proposal leaves them null. `sourceCommentId`
  // (the GitHub comment databaseId a cloud worker's `<!-- pm:followup -->` comment
  // carries) doubles as the watcher's ingest idempotency key: a comment already
  // turned into a proposal is never re-ingested. `sourceTaskId` is the task the
  // worker was on (plain int, not an FK — a cloud PR resolves an id that may not be a
  // live row); `sourcePr` ties it back to the PR it was slurped from.
  sourceTaskId: integer("source_task_id"),
  sourcePr: integer("source_pr"),
  // GitHub comment databaseIds are ~10 digits (billions) — bigint, not int4, or the
  // followup-ingest write overflows ("value … is out of range for type integer").
  // `mode: "number"` keeps the TS type a plain number (ids stay well under 2^53).
  sourceCommentId: bigint("source_comment_id", { mode: "number" }),
  ...timestamps,
});

// Types derived directly from the table definitions — no separate schema layer.
export type Goal = typeof goals.$inferSelect;
export type Milestone = typeof milestones.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type Phase = typeof phases.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type SessionTask = typeof sessionTasks.$inferSelect;
export type TaskComment = typeof taskComments.$inferSelect;
export type Repo = typeof repos.$inferSelect;
export type Note = typeof notes.$inferSelect;
export type PullRequestRow = typeof pullRequests.$inferSelect;
export type Settings = typeof settings.$inferSelect;
export type Proposal = typeof proposals.$inferSelect;
