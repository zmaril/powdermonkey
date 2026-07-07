ALTER TABLE "sessions" ADD COLUMN "vm_name" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "dispatch_backend" text DEFAULT 'exe-dev' NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "exe_template" text DEFAULT 'powdermonkey' NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "exe_ttyd_port" integer DEFAULT 3456 NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "exe_claude_flags" text DEFAULT '--dangerously-skip-permissions' NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "exe_auto_teardown" boolean DEFAULT true NOT NULL;