CREATE TABLE "proposals" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "proposals_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"title" text DEFAULT '' NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"changes" jsonb NOT NULL,
	"base" jsonb NOT NULL,
	"applied_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"archived_at" timestamp
);
