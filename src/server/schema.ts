import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { PhaseStatus, SessionKind, SessionState, TaskStatus } from "../shared/types.ts";

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
  // Progress is set during reconciliation when a PR merges, never self-reported.
  status: text("status").$type<TaskStatus>().notNull().default("pending"),
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
  status: text("status").$type<PhaseStatus>().notNull().default("todo"),
  position: integer("position").notNull().default(0),
  ...timestamps,
});

// One run of work. Independent of the hierarchy — a session may pull work from
// multiple goals at once. Created at runtime, never authored. A `local` session
// executes in a git worktree on `branch`; a `remote` one is a `claude --remote`
// run reachable at `url`.
export const sessions = pgTable("sessions", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  kind: text("kind").$type<SessionKind>().notNull().default("local"),
  state: text("state").$type<SessionState>().notNull().default("running"),
  taskId: integer("task_id").references(() => tasks.id),
  branch: text("branch"),
  worktreePath: text("worktree_path"),
  url: text("url"),
  ...timestamps,
});

// Types derived directly from the table definitions — no separate schema layer.
export type Goal = typeof goals.$inferSelect;
export type Milestone = typeof milestones.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type Phase = typeof phases.$inferSelect;
export type Session = typeof sessions.$inferSelect;
