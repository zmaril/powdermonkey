ALTER TABLE "settings" ADD COLUMN "sync_mode" text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "sync_branch" text DEFAULT 'powdermonkey-backup' NOT NULL;