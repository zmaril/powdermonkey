CREATE TABLE "actions" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigint NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"summary" text,
	"diff" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"session_id" text,
	"kind" text NOT NULL,
	"summary" text,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"message" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_threads" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text,
	"kind" text DEFAULT 'assistant' NOT NULL,
	"goal_id" text,
	"task_id" text,
	"title" text,
	"claude_session_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "claims" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"session_id" text,
	"summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "goals" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"title" text NOT NULL,
	"intent" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "milestones" (
	"id" text PRIMARY KEY NOT NULL,
	"goal_id" text NOT NULL,
	"title" text NOT NULL,
	"detail" text,
	"order_hint" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" text PRIMARY KEY NOT NULL,
	"goal_id" text NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"status" text DEFAULT 'proposed' NOT NULL,
	"proposed_tasks" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "scratchpad" (
	"id" text PRIMARY KEY NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"workstream_id" text,
	"current_task_id" text,
	"task_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'starting' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"workstream_id" text,
	"milestone_id" text,
	"plan_id" text,
	"title" text NOT NULL,
	"objective" text DEFAULT '' NOT NULL,
	"kind" text DEFAULT 'implementation' NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"session_id" text,
	"branch" text,
	"worktree_path" text,
	"base_ref" text,
	"token" text,
	"question" text,
	"last_progress" text,
	"order_hint" integer,
	"after_task_ids" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"repo_path" text,
	"subpath" text,
	"secrets" jsonb,
	"env_files" jsonb,
	"setup" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workstreams" (
	"id" text PRIMARY KEY NOT NULL,
	"goal_id" text NOT NULL,
	"starting_plan_id" text,
	"title" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "idx_actions_seq" ON "actions" USING btree ("seq");--> statement-breakpoint
CREATE INDEX "idx_actions_entity" ON "actions" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "idx_artifacts_task" ON "artifacts" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "idx_chat_messages_thread" ON "chat_messages" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "idx_claims_task" ON "claims" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "idx_goals_workspace" ON "goals" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_milestones_goal" ON "milestones" USING btree ("goal_id");--> statement-breakpoint
CREATE INDEX "idx_plans_goal" ON "plans" USING btree ("goal_id");--> statement-breakpoint
CREATE INDEX "idx_tasks_workstream" ON "tasks" USING btree ("workstream_id");--> statement-breakpoint
CREATE INDEX "idx_tasks_status" ON "tasks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_workstreams_goal" ON "workstreams" USING btree ("goal_id");