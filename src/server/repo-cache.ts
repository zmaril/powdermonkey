import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { repoRepo } from "./crud.ts";
import { db } from "./db.ts";
import { cloneRepo, fetchRepo } from "./git.ts";
import { tasks } from "./schema.ts";

// Per-repo cache clones. A Repo is cloud-first — its identity of record is the
// GitHub slug (`owner/name`), not a local checkout. But dispatch and local
// sessions still need a working tree to run in, so PowderMonkey keeps a transient
// cache clone per repo under `~/.powdermonkey/repos/<owner>/<name>`, cloned on
// demand and fetched to freshness before each use. `ensureRepo` is the single door
// to that cache: it clones if the dir is missing, fetches if it's there, and
// serializes concurrent callers for the same slug so two sessions launching at once
// never run git on the same clone simultaneously. See docs/vocabulary.md.

/** The supervisor's own checkout — the fallback repo dir for a task with no repo
 *  pinned (pre-registry tasks the boot seed hasn't backfilled, or tests). */
export function supervisorRepoDir(): string {
  return process.env.PM_REPO_DIR ?? process.cwd();
}

/** Root of the per-repo cache clones. `~/.powdermonkey/repos` by default; overridable
 *  with PM_REPOS_DIR (tests point it at a scratch dir). */
export function reposCacheRoot(): string {
  return process.env.PM_REPOS_DIR ?? join(homedir(), ".powdermonkey", "repos");
}

/** The on-disk cache-clone path for a slug: `<root>/<owner>/<name>`. Pure — the
 *  clone may or may not exist yet (that's `ensureRepo`'s job). */
export function repoCachePath(slug: string): string {
  return join(reposCacheRoot(), ...slug.split("/"));
}

/** The git URL we clone a slug from. Defaults to HTTPS on github.com (auth comes
 *  from the operator's git credential helper, same as `gh`). PM_CLONE_BASE overrides
 *  the base — tests point it at a local remote so no network is touched. */
function cloneUrl(slug: string): string {
  const base = process.env.PM_CLONE_BASE ?? "https://github.com/";
  return `${base}${slug}.git`;
}

function isGitClone(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

export type EnsureRepoResult =
  | { ok: true; dir: string; action: "cloned" | "fetched" }
  | { ok: false; dir: string; error: string; output?: string };

// One in-flight chain per slug. The supervisor is a single process (guarded by the
// PGlite writer lock), so an in-process mutex is the whole lock we need: it stops
// two concurrent launches against the same repo from cloning/fetching the same clone
// at once. Each call waits for the prior chain to *settle* (ok or error) before it
// runs, so a failed ensure never wedges the next caller.
const chains = new Map<string, Promise<unknown>>();

/** Ensure a fresh cache clone for `slug` exists under the cache root and return its
 *  path. Clones when absent, fetches when present. Concurrent calls for the same slug
 *  are serialized. Network/git failures come back as `{ ok: false }` for the caller
 *  to surface — a clone that already exists is still returned as its dir on a failed
 *  fetch so an offline supervisor can fall back to the stale clone. */
export function ensureRepo(slug: string): Promise<EnsureRepoResult> {
  const prev = chains.get(slug) ?? Promise.resolve();
  const next = prev.then(
    () => ensureRepoInner(slug),
    () => ensureRepoInner(slug),
  );
  // Store an error-swallowing tail so the chain keeps flowing after a failure.
  chains.set(
    slug,
    next.catch(() => {}),
  );
  return next;
}

async function ensureRepoInner(slug: string): Promise<EnsureRepoResult> {
  const dir = repoCachePath(slug);
  if (isGitClone(dir)) {
    // A failed fetch (offline, transient) is non-fatal: the existing clone is still
    // usable, just possibly stale. Report ok with the dir so callers keep working.
    await fetchRepo(dir);
    return { ok: true, dir, action: "fetched" };
  }
  mkdirSync(dirname(dir), { recursive: true });
  const r = await cloneRepo(cloneUrl(slug), dir);
  if (!r.ok) return { ok: false, dir, error: "git clone failed", output: r.output };
  return { ok: true, dir, action: "cloned" };
}

/** The cache-clone dir a task runs in. Resolves the task's pinned repo → its slug →
 *  cache clone. When `ensure` is set, clones/fetches the clone to freshness first
 *  (dispatch / start of a session); otherwise returns the path without touching git
 *  (teardown, where the clone already exists and we only need to know which repo owns
 *  the worktree). A task with no repo pinned falls back to the supervisor's own
 *  checkout — that's the pre-registry / repo-less path, which keeps working unchanged. */
export type RepoDir = {
  dir: string;
  // The branch a session's worktree is cut off (the repo's default branch), so
  // start-local branches `pm/task-<id>` from the right base in a non-`main` repo.
  // Undefined for the supervisor-repo fallback — the caller uses PM_MAIN_BRANCH.
  baseBranch?: string;
  error?: string;
  output?: string;
};

export async function repoDirForTask(
  taskId: number,
  opts: { ensure?: boolean } = {},
): Promise<RepoDir> {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task?.repoId) return { dir: supervisorRepoDir() };
  const repo = await repoRepo.get(task.repoId);
  if (!repo) return { dir: supervisorRepoDir() };

  const baseBranch = repo.defaultBranch;
  if (!opts.ensure) return { dir: repoCachePath(repo.slug), baseBranch };

  const res = await ensureRepo(repo.slug);
  if (!res.ok) return { dir: res.dir, baseBranch, error: res.error, output: res.output };
  return { dir: res.dir, baseBranch };
}
