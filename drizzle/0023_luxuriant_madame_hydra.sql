ALTER TABLE "task_comments" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "task_comments" ADD COLUMN "archived_at" timestamp;