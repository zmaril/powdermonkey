// entl: the read layer over git + GitHub. One in-process engine (DuckDB under
// data/) replaces the `gh api graphql` poll and the git-log shell-outs: each
// `loadGithub` is an incremental sync (etag-gated — ~1 REST + ~6 GraphQL points
// when idle), and the tables (`gh_pull_requests`, `gh_comments`, `commits`, …)
// are queried with SQL. Auth rides the operator's `gh auth token`, same as the
// old seam. WRITES stay on git.ts/gh.ts — entl is read-only by design.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Entl } from "@entl/node";

// Sibling of the PGlite store: `data/entl.duckdb` (its own file — different
// engine, different writer). The store is a derived cache; deleting it just
// means the next sync re-ingests.
const ENTL_DB = process.env.PM_ENTL_DB ?? "data/entl.duckdb";

let engine: Entl | null = null;

/** The engine, opened lazily (schema applied on first open). One per process —
 *  in-process means one DuckDB. */
export function entl(): Entl {
  if (!engine) {
    mkdirSync(dirname(ENTL_DB), { recursive: true });
    engine = new Entl(ENTL_DB);
  }
  return engine;
}

/** The repo the supervisor watches — the same default `git.ts` uses. */
export function watchRepoDir(): string {
  return process.env.PM_REPO_DIR ?? process.cwd();
}

/** Run a SQL query against the entl store; typed JSON rows back. */
export async function entlRows<T>(sql: string): Promise<T[]> {
  return JSON.parse(await entl().query(sql)) as T[];
}
