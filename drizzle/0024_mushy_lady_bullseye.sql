-- pull_requests goes multi-repo: PR numbers are only unique within a repo, so the
-- key becomes (repo, number). Existing rows predate the column — backfill the slug
-- out of the PR's own GitHub URL (https://github.com/<owner>/<name>/pull/<n>) so
-- the rebase-ask ledger survives the upgrade.
ALTER TABLE "pull_requests" ADD COLUMN "repo" text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE "pull_requests" SET "repo" = split_part(split_part("url", '://github.com/', 2), '/pull/', 1) WHERE "url" LIKE '%://github.com/%/pull/%';--> statement-breakpoint
ALTER TABLE "pull_requests" ALTER COLUMN "repo" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "pull_requests" DROP CONSTRAINT "pull_requests_pkey";--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_repo_number_pk" PRIMARY KEY("repo","number");
