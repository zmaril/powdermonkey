// The supervisor pulls `main` to *know* the repo's current state before it plans
// or reports — NOT for execution correctness (the cloud always execs against
// main regardless). See design.md "Running".

import { spawnCapture } from "./proc.ts";

export type GitResult = { ok: boolean; output: string };

/** Run `git` in a repo. Defaults to the supervisor's own checkout
 *  (`PM_REPO_DIR ?? cwd`); pass `cwd` to run inside a per-repo cache clone under
 *  `~/.powdermonkey/repos` (see repo-cache.ts) — that's how worktree ops and
 *  fetches target the task's repo rather than the supervisor's. */
async function run(args: string[], cwd?: string): Promise<GitResult> {
  const { code, stdout, stderr } = await spawnCapture(["git", ...args], {
    cwd: cwd ?? process.env.PM_REPO_DIR ?? process.cwd(),
  });
  return { ok: code === 0, output: (stdout + stderr).trim() };
}

export function pullMain(): Promise<GitResult> {
  return run(["pull", "--ff-only", "origin", "main"]);
}

export async function currentBranch(): Promise<string> {
  const r = await run(["rev-parse", "--abbrev-ref", "HEAD"]);
  return r.output;
}

/**
 * Concatenated commit message bodies for every commit reachable from `branch`.
 * Reconciliation scans these for PM trailers. Returns "" if the branch is missing
 * (e.g. a fresh repo) rather than throwing.
 */
export async function commitBodies(branch: string): Promise<string> {
  const r = await run(["log", branch, "--format=%B%x00"]);
  return r.ok ? r.output : "";
}

export async function branchExists(branch: string, cwd?: string): Promise<boolean> {
  const r = await run(["rev-parse", "--verify", "--quiet", branch], cwd);
  return r.ok;
}

/** Clone `url` into `dir` (a fresh cache clone). The target path is absolute, so
 *  this is cwd-independent. */
export function cloneRepo(url: string, dir: string): Promise<GitResult> {
  return run(["clone", url, dir]);
}

/** Fetch `origin` inside an existing cache clone at `dir`, refreshing its refs so
 *  a worktree cut off the default branch (or reconciliation's trailer scan) sees
 *  current state. `--prune` drops server-deleted branches. */
export function fetchRepo(dir: string): Promise<GitResult> {
  return run(["fetch", "--prune", "origin"], dir);
}

/** Add a worktree at `path`; create `branch` off `baseRef` if it doesn't exist yet.
 *  `cwd` selects the repo the worktree is cut from (default: the supervisor's own). */
export async function worktreeAdd(
  path: string,
  branch: string,
  baseRef: string,
  cwd?: string,
): Promise<GitResult> {
  if (await branchExists(branch, cwd)) return run(["worktree", "add", path, branch], cwd);
  return run(["worktree", "add", "-b", branch, path, baseRef], cwd);
}

/** List remote branch names (without the `refs/heads/` prefix) matching `pattern`,
 *  e.g. `refs/heads/pm/task-12*`. Returns [] when the remote has no match (or the
 *  call fails). Used to discover the branch a cloud worker pushed for a task. */
export async function lsRemoteHeads(pattern: string): Promise<string[]> {
  const r = await run(["ls-remote", "--heads", "origin", pattern]);
  if (!r.ok || !r.output) return [];
  return r.output
    .split("\n")
    .map((line) => line.split("\t")[1])
    .filter((ref): ref is string => Boolean(ref))
    .map((ref) => ref.replace(/^refs\/heads\//, ""));
}

/** Add a worktree checked out to `branch`, which may exist only on the remote (the
 *  cloud worker pushed it but we've never fetched it). Fetch origin/<branch> first,
 *  then: use a local branch if one exists, else create a local branch tracking the
 *  fetched remote one, else fall back to creating <branch> off `baseRef` (nothing
 *  was pushed). The fetch is best-effort — a missing remote branch is not fatal. */
export async function worktreeAddRemote(
  path: string,
  branch: string,
  baseRef: string,
  cwd?: string,
): Promise<GitResult> {
  await run(["fetch", "origin", branch], cwd);
  if (await branchExists(branch, cwd)) return run(["worktree", "add", path, branch], cwd);
  if (await branchExists(`origin/${branch}`, cwd))
    return run(["worktree", "add", "-b", branch, path, `origin/${branch}`], cwd);
  return run(["worktree", "add", "-b", branch, path, baseRef], cwd);
}

/** Remove a worktree. Not forced by default — fails if it has uncommitted changes,
 *  which is what `land` wants. Pass `{ force: true }` to remove regardless (an
 *  aborted session via `stop` discards its in-progress work rather than waiting
 *  for a clean tree). `cwd` selects the repo that owns the worktree (default: the
 *  supervisor's own) — a worktree cut from a cache clone must be removed from it. */
export function worktreeRemove(
  path: string,
  opts?: { force?: boolean; cwd?: string },
): Promise<GitResult> {
  const args = ["worktree", "remove", path];
  if (opts?.force) args.push("--force");
  return run(args, opts?.cwd);
}
