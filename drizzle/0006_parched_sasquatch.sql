CREATE TABLE "pull_requests" (
	"number" integer PRIMARY KEY NOT NULL,
	"task_id" integer NOT NULL,
	"url" text NOT NULL,
	"state" text NOT NULL,
	"is_draft" boolean DEFAULT false NOT NULL,
	"merged" boolean DEFAULT false NOT NULL,
	"checks" text,
	"mergeable" text,
	"head_ref_name" text NOT NULL,
	"gh_updated_at" text NOT NULL,
	"rebase_asked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"archived_at" timestamp
);
