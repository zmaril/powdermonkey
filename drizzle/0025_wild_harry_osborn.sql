-- pull_requests gains a composite (repo, number) primary key for multi-repo
-- support. drizzle-kit can't auto-name the old single-column PK to drop it, so
-- the correct order is written by hand: add the new column, drop the old
-- number-only PK (pull_requests_pkey, from the inline PRIMARY KEY in 0006),
-- then add the composite PK.
ALTER TABLE "pull_requests" ADD COLUMN "repo" text NOT NULL;--> statement-breakpoint
ALTER TABLE "pull_requests" DROP CONSTRAINT "pull_requests_pkey";--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_repo_number_pk" PRIMARY KEY("repo","number");
