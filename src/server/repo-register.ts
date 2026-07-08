import { repoRepo } from "./crud.ts";
import { gh } from "./gh.ts";
import type { Repo } from "./schema.ts";

// The write side of the Blender-style picker: registering a picked slug into the
// flat repo registry, fork-first (docs/vocabulary.md § Repo). A slug the operator
// can push to is recorded directly; one they can't is forked
// (`gh repo fork --clone=false`) and *the fork* is registered, with `upstream`
// recording the source. Cloud dispatch needs push access (the sandbox pushes via
// the GitHub App on a repo the operator controls), so fork-first is what makes
// driving someone else's public repo actually work. Same seam rules as
// repo-picker.ts: pure argv builders/parsers, orchestration over an injectable
// gh runner, never throws — failures come back `{ ok: false }` for the route.

export type RepoView = {
  /** Canonical "owner/name" as GitHub reports it (fixes the operator's casing). */
  slug: string;
  defaultBranch: string | null;
  homepageUrl: string | null;
  /** GraphQL viewerPermission: ADMIN | MAINTAIN | WRITE | TRIAGE | READ | null. */
  viewerPermission: string | null;
};

export function viewRepoArgs(slug: string): string[] {
  return [
    "repo",
    "view",
    slug,
    "--json",
    "nameWithOwner,defaultBranchRef,homepageUrl,viewerPermission",
  ];
}

export function parseRepoView(stdout: string): RepoView | null {
  // biome-ignore lint/suspicious/noExplicitAny: gh JSON, narrowed field by field.
  let j: any;
  try {
    j = JSON.parse(stdout);
  } catch {
    return null;
  }
  const slug = typeof j?.nameWithOwner === "string" ? j.nameWithOwner : "";
  if (!slug.includes("/")) return null;
  return {
    slug,
    defaultBranch: typeof j?.defaultBranchRef?.name === "string" ? j.defaultBranchRef.name : null,
    homepageUrl: typeof j?.homepageUrl === "string" && j.homepageUrl ? j.homepageUrl : null,
    viewerPermission: typeof j?.viewerPermission === "string" ? j.viewerPermission : null,
  };
}

/** Push access is what dispatch needs; TRIAGE/READ (and null) mean fork-first. */
export function canPush(viewerPermission: string | null): boolean {
  return (
    viewerPermission === "ADMIN" || viewerPermission === "MAINTAIN" || viewerPermission === "WRITE"
  );
}

export function forkArgs(slug: string): string[] {
  return ["repo", "fork", slug, "--clone=false"];
}

/** The fork's slug out of `gh repo fork` output — "Created fork o/n" on a fresh
 *  fork, "o/n already exists" on a re-fork. gh prints both to stderr, so callers
 *  hand the combined output in. Null when neither shape is found. */
export function parseForkSlug(output: string): string | null {
  const m =
    output.match(/Created fork\s+([\w.-]+\/[\w.-]+)/) ??
    output.match(/([\w.-]+\/[\w.-]+) already exists/);
  return m ? m[1] : null;
}

export type RegisterResult =
  | { ok: true; repo: Repo; created: boolean; forked: boolean }
  | { ok: false; error: string };

type Run = typeof gh;

/** Register `slug` into the repo registry, forking first when the operator can't
 *  push to it. Idempotent on the live set (schema: no unique constraint, so an
 *  archived row can be re-added): a slug already registered — directly, or as the
 *  `upstream` of a fork we made earlier — returns the existing row untouched. */
export async function registerRepo(slugInput: string, run: Run = gh): Promise<RegisterResult> {
  const slug = slugInput.trim();
  const live = await repoRepo.list();
  const existing = live.find((r) => r.slug === slug || r.upstream === slug);
  if (existing) return { ok: true, repo: existing, created: false, forked: false };

  const viewed = await run(viewRepoArgs(slug));
  const view = viewed.ok ? parseRepoView(viewed.stdout) : null;
  if (!view) return { ok: false, error: viewed.stderr.trim() || `gh repo view ${slug} failed` };

  if (canPush(view.viewerPermission)) {
    // Re-check against the canonical casing gh returned before creating.
    const canon = live.find((r) => r.slug === view.slug || r.upstream === view.slug);
    if (canon) return { ok: true, repo: canon, created: false, forked: false };
    const repo = await createRow(view, null);
    return { ok: true, repo, created: true, forked: false };
  }

  const forked = await run(forkArgs(view.slug));
  if (!forked.ok) {
    return { ok: false, error: forked.stderr.trim() || `gh repo fork ${view.slug} failed` };
  }
  // gh's success output isn't guaranteed parseable in every mode, so fall back to
  // <viewer login>/<name> — what a fork is named unless GitHub had to dedupe it.
  const forkSlug =
    parseForkSlug(`${forked.stdout}\n${forked.stderr}`) ?? (await fallbackForkSlug(view.slug, run));
  if (!forkSlug)
    return { ok: false, error: `could not determine the fork's slug for ${view.slug}` };

  const dupFork = live.find((r) => r.slug === forkSlug);
  if (dupFork) return { ok: true, repo: dupFork, created: false, forked: false };

  // The fork's own metadata can lag right after creation — fall back to the
  // upstream's, which a fresh fork inherits anyway.
  const forkViewed = await run(viewRepoArgs(forkSlug));
  const forkView = forkViewed.ok ? parseRepoView(forkViewed.stdout) : null;
  const repo = await createRow(
    {
      slug: forkView?.slug ?? forkSlug,
      defaultBranch: forkView?.defaultBranch ?? view.defaultBranch,
      homepageUrl: forkView?.homepageUrl ?? view.homepageUrl,
      viewerPermission: null,
    },
    view.slug,
  );
  return { ok: true, repo, created: true, forked: true };
}

async function fallbackForkSlug(sourceSlug: string, run: Run): Promise<string | null> {
  const r = await run(["api", "user", "-q", ".login"]);
  const login = r.ok ? r.stdout.trim() : "";
  if (!login) return null;
  return `${login}/${sourceSlug.split("/")[1]}`;
}

function createRow(view: RepoView, upstream: string | null): Promise<Repo> {
  const [owner, name] = view.slug.split("/");
  return repoRepo.create({
    slug: view.slug,
    owner,
    name,
    defaultBranch: view.defaultBranch ?? "main",
    homepageUrl: view.homepageUrl,
    upstream,
  });
}
