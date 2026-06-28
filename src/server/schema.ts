import { boolean, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { PhaseStatus, SessionKind, SessionState, TaskStatus } from "../shared/types.ts";

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
  ...timestamps,
});

export const milestones = pgTable("milestones", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  goalId: integer("goal_id")
    .notNull()
    .references(() => goals.id),
  title: text("title").notNull(),
  position: integer("position").notNull().default(0),
  ...timestamps,
});

export const tasks = pgTable("tasks", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  milestoneId: integer("milestone_id")
    .notNull()
    .references(() => milestones.id),
  title: text("title").notNull(),
  position: integer("position").notNull().default(0),
  // Operator priority: a starred task sorts to the top of its group (active/backlog).
  starred: boolean("starred").notNull().default(false),
  // Progress is set during reconciliation when a PR merges, never self-reported.
  status: text("status").$type<TaskStatus>().notNull().default(TaskStatus.Pending),
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

// Cloud-PR status mirror. The github-watch loop polls GitHub for the PRs cloud
// workers open and upserts the fields the UI reacts to (state, CI checks,
// mergeable, draft) here — so PR status lives in PGlite like everything else, and
// the realtime change feed pushes badge updates with no special-casing. Keyed by
// PR number (unique per repo). `taskId` is the resolved task but carries no FK: a
// PR can name a branch whose task was deleted, and that must never block the upsert.
// This is fast-moving runtime data, not part of the goal hierarchy, so no
// archived_at — rows are simply upserted to the latest observed state.
export const cloudPrs = pgTable("cloud_prs", {
  number: integer("number").primaryKey(),
  taskId: integer("task_id").notNull(),
  url: text("url").notNull(),
  state: text("state").$type<"OPEN" | "CLOSED" | "MERGED">().notNull(),
  isDraft: boolean("is_draft").notNull().default(false),
  merged: boolean("merged").notNull().default(false),
  checks: text("checks"),
  mergeable: text("mergeable"),
  headRefName: text("head_ref_name").notNull(),
  // GitHub's own updatedAt (ISO string) — surfaced to the UI, not our bookkeeping.
  updatedAt: text("updated_at").notNull(),
});

// Types derived directly from the table definitions — no separate schema layer.
export type Goal = typeof goals.$inferSelect;
export type Milestone = typeof milestones.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type Phase = typeof phases.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type SessionTask = typeof sessionTasks.$inferSelect;
export type Note = typeof notes.$inferSelect;
export type CloudPrRow = typeof cloudPrs.$inferSelect;
