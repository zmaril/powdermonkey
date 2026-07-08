import { gh } from "./gh.ts";

// The gh seam behind the Blender-style repo picker (docs/vocabulary.md § Repo):
// the two read sources it offers — the operator's own repos (`gh repo list`) and a
// public GitHub search (`gh search repos`). Both normalize to one PickerRepo shape
// so the picker renders a single list regardless of source. The argv builders and
// parsers are pure (unit-tested without spawning); the exported list/search
// functions are thin orchestrations over gh() that never throw — a missing `gh`,
// no auth, or garbage output all come back as `{ ok: false }` for the route to 502.

export type PickerRepo = {
  /** GitHub identity, "owner/name" — the registry's natural key. */
  slug: string;
  description: string;
  /** Lowercased ("public" | "private"); search results are always public. */
  visibility: string;
  /** Star count — carried by search results only; null for your own list. */
  stars: number | null;
};

export type PickerResult = { ok: true; repos: PickerRepo[] } | { ok: false; error: string };

/** `gh repo list` argv: every repo the operator can see as theirs. */
export function listReposArgs(limit = 100): string[] {
  return [
    "repo",
    "list",
    "--json",
    "nameWithOwner,description,visibility",
    "--limit",
    String(limit),
  ];
}

/** `gh search repos` argv for a public-repo query. */
export function searchReposArgs(query: string, limit = 30): string[] {
  return [
    "search",
    "repos",
    query,
    "--json",
    "fullName,description,stargazersCount",
    "--limit",
    String(limit),
  ];
}

// Both parsers tolerate anything that isn't the expected JSON array (gh version
// drift, a warning line on stdout) by returning [] — the picker just shows nothing
// rather than the route crashing on someone else's output format.

/** Rows out of `gh repo list --json nameWithOwner,description,visibility`. */
export function parseRepoList(stdout: string): PickerRepo[] {
  return parseRows(stdout, (row) => ({
    slug: str(row.nameWithOwner),
    description: str(row.description),
    // gh reports GraphQL casing ("PUBLIC"); normalize so the UI compares one form.
    visibility: str(row.visibility).toLowerCase(),
    stars: null,
  }));
}

/** Rows out of `gh search repos --json fullName,description,stargazersCount`. */
export function parseRepoSearch(stdout: string): PickerRepo[] {
  return parseRows(stdout, (row) => ({
    slug: str(row.fullName),
    description: str(row.description),
    visibility: "public",
    stars: typeof row.stargazersCount === "number" ? row.stargazersCount : null,
  }));
}

// biome-ignore lint/suspicious/noExplicitAny: gh JSON, narrowed by the row mappers.
type Json = any;

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function parseRows(stdout: string, map: (row: Json) => PickerRepo): PickerRepo[] {
  let rows: Json;
  try {
    rows = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  return rows.map(map).filter((r) => r.slug.includes("/"));
}

type Run = typeof gh;

/** The operator's own repos. `run` is injectable for tests; defaults to real gh. */
export async function listMyRepos(run: Run = gh): Promise<PickerResult> {
  const r = await run(listReposArgs());
  if (!r.ok) return { ok: false, error: r.stderr.trim() || "gh repo list failed" };
  return { ok: true, repos: parseRepoList(r.stdout) };
}

/** Public-repo search. `gh search` exits 1 on zero matches — so any parseable
 *  JSON array on stdout (including `[]`) is a valid result regardless of exit
 *  code, and only a run with nothing usable on stdout maps to an error. */
export async function searchRepos(query: string, run: Run = gh): Promise<PickerResult> {
  const r = await run(searchReposArgs(query));
  if (isJsonArray(r.stdout)) return { ok: true, repos: parseRepoSearch(r.stdout) };
  if (!r.ok) return { ok: false, error: r.stderr.trim() || "gh search repos failed" };
  return { ok: true, repos: [] };
}

function isJsonArray(text: string): boolean {
  try {
    return Array.isArray(JSON.parse(text));
  } catch {
    return false;
  }
}
