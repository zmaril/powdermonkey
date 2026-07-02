import { isNull } from "drizzle-orm";
import { repoRepo } from "./crud.ts";
import { db } from "./db.ts";
import { gh, resolveRepo } from "./gh.ts";
import { type Repo, tasks } from "./schema.ts";

// Upgrade path from a single-repo install to the flat repo registry: on boot, make
// sure the supervisor's own repo (the one it was pointed at before repos existed) is
// in the registry, so PowderMonkey-on-itself becomes "a window showing one repo."
// See docs/vocabulary.md § Migration.

/** The repo's default branch + homepage from `gh`, tolerating any failure (headless
 *  container, no auth, unexpected shape) — the caller falls back to sensible defaults
 *  so a seed still lands without GitHub. */
async function repoMeta(slug: string): Promise<{ defaultBranch?: string; homepageUrl?: string }> {
  const r = await gh([
    "repo",
    "view",
    slug,
    "--json",
    "defaultBranchRef,homepageUrl",
    "-q",
    "{b: .defaultBranchRef.name, h: .homepageUrl}",
  ]);
  if (!r.ok) return {};
  try {
    const j = JSON.parse(r.stdout) as { b?: string; h?: string };
    return { defaultBranch: j.b || undefined, homepageUrl: j.h || undefined };
  } catch {
    return {};
  }
}

/** Seed the registry with the supervisor's own repo. Idempotent — find-or-create by
 *  slug over the whole registry (archived rows included, so a repo the operator
 *  archived by hand is never resurrected), a no-op once the row exists. No-ops too
 *  when there's no GitHub repo to resolve (no `gh` auth / no `$PM_GITHUB_REPO`).
 *
 *  On first registration — the one-time upgrade moment — it also **backfills**: every
 *  existing repo-less task is attached to the new repo, so a pre-registry plan becomes
 *  "one repo's worth of work" with no data loss. Only runs on create (not on the
 *  idempotent no-op), so once multiple repos exist a task authored without a repo isn't
 *  silently swept onto the supervisor's own.
 *
 *  `resolve` is injectable for tests. Returns the existing/created row, or null when
 *  skipped. */
export async function seedSupervisorRepo(
  resolve: typeof resolveRepo = resolveRepo,
): Promise<Repo | null> {
  const slugParts = await resolve();
  if (!slugParts) return null;
  const slug = `${slugParts.owner}/${slugParts.name}`;
  const existing = (await repoRepo.list({ includeArchived: true })).find((r) => r.slug === slug);
  if (existing) return existing;
  const meta = await repoMeta(slug);
  const created = await repoRepo.create({
    slug,
    owner: slugParts.owner,
    name: slugParts.name,
    defaultBranch: meta.defaultBranch ?? "main",
    homepageUrl: meta.homepageUrl ?? null,
  });
  // Backfill: attach every existing repo-less task (live or archived) to the repo we
  // just registered — the flat registry's upgrade migration for the plan spine.
  await db
    .update(tasks)
    .set({ repoId: created.id, updatedAt: new Date() })
    .where(isNull(tasks.repoId));
  return created;
}
