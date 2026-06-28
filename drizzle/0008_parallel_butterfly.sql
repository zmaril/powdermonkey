ALTER TABLE "pull_requests" ADD COLUMN "agent_state" text;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD COLUMN "agent_summary" text;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD COLUMN "agent_next" text;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD COLUMN "agent_body" text;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD COLUMN "agent_updated_at" text;