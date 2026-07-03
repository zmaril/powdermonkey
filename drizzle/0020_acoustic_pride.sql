ALTER TABLE "goals" ADD COLUMN "repo_id" integer;--> statement-breakpoint
ALTER TABLE "milestones" ADD COLUMN "repo_id" integer;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;