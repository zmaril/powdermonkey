ALTER TABLE "sessions" ADD COLUMN "kind" text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "task_id" integer;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "branch" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "worktree_path" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;