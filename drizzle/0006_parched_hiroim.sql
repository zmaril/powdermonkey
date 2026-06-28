CREATE TABLE "cloud_prs" (
	"number" integer PRIMARY KEY NOT NULL,
	"task_id" integer NOT NULL,
	"url" text NOT NULL,
	"state" text NOT NULL,
	"is_draft" boolean DEFAULT false NOT NULL,
	"merged" boolean DEFAULT false NOT NULL,
	"checks" text,
	"mergeable" text,
	"head_ref_name" text NOT NULL,
	"updated_at" text NOT NULL
);
