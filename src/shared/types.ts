// Shared vocabulary for PowderMonkey. The entity shapes are DERIVED from the
// Drizzle schema (the single source of truth) via `$inferSelect`; only the
// board-state extras (board column, joined artifacts, the JSON-serialized
// timestamps) are spelled out here. The schema import is type-only, so it is
// erased from the browser bundle.

import type {
  artifacts,
  goals,
  milestones,
  plans,
  sessions,
  tasks,
  workspaces,
  workstreams,
} from "../server/schema.ts";

// Re-export the domain enums that live in the schema.
export type {
  ActionName,
  Actor,
  ArtifactKind,
  EntityType,
  GoalStatus,
  MilestoneStatus,
  PlanStatus,
  SessionStatus,
  TaskKind,
  TaskStatus,
  WorkstreamStatus,
} from "../server/schema.ts";

// Over-the-wire shape: Date columns serialize to ISO strings.
type Json<T> = {
  [K in keyof T]: T[K] extends Date ? string : T[K] extends Date | null ? string | null : T[K];
};
// A live entity as the API returns it: JSON-shaped, minus the audit columns.
type Entity<T> = Omit<Json<T>, "createdAt" | "updatedAt" | "archivedAt">;

// The three attention buckets the board groups tasks into (derived from status).
export type BoardColumn = "working" | "needs_input" | "done";

// Proposed tasks live inside a Plan's jsonb (not their own table) — derive the
// element shape from the column.
export type ProposedTask = NonNullable<(typeof plans.$inferSelect)["proposedTasks"]>[number];

export type Workspace = Entity<typeof workspaces.$inferSelect>;
export type Goal = Entity<typeof goals.$inferSelect>;
export type Workstream = Entity<typeof workstreams.$inferSelect>;
export type Milestone = Entity<typeof milestones.$inferSelect>;
export type Session = Entity<typeof sessions.$inferSelect>;

export type Plan = Omit<Entity<typeof plans.$inferSelect>, "proposedTasks"> & {
  proposedTasks: ProposedTask[];
};

// Artifact surfaces `at` (= the row's created_at) and a non-null payload.
export type Artifact = Omit<Entity<typeof artifacts.$inferSelect>, "payload"> & {
  payload: Record<string, unknown>;
  at: string;
};

// Task drops the worker `token`, surfaces `updatedAt` as a string, and adds the
// derived board `column` plus its joined artifacts.
export type Task = Omit<Entity<typeof tasks.$inferSelect>, "token"> & {
  updatedAt: string;
  column: BoardColumn;
  artifacts: Artifact[];
};

// The full board state the API returns.
export interface BoardState {
  seq: number;
  workspaces: Workspace[];
  goals: Goal[];
  plans: Plan[];
  workstreams: Workstream[];
  milestones: Milestone[];
  tasks: Task[];
  sessions: Session[];
}
