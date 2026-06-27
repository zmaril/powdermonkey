// The supervisor pulls `main` to *know* the repo's current state before it plans
// or reports — NOT for execution correctness (the cloud always execs against
// main regardless). See design.md "Running".

export type GitResult = { ok: boolean; output: string };

async function run(args: string[]): Promise<GitResult> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: process.env.PM_REPO_DIR ?? process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
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

export async function branchExists(branch: string): Promise<boolean> {
  const r = await run(["rev-parse", "--verify", "--quiet", branch]);
  return r.ok;
}

/** Add a worktree at `path`; create `branch` off `baseRef` if it doesn't exist yet. */
export async function worktreeAdd(
  path: string,
  branch: string,
  baseRef: string,
): Promise<GitResult> {
  if (await branchExists(branch)) return run(["worktree", "add", path, branch]);
  return run(["worktree", "add", "-b", branch, path, baseRef]);
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
): Promise<GitResult> {
  await run(["fetch", "origin", branch]);
  if (await branchExists(branch)) return run(["worktree", "add", path, branch]);
  if (await branchExists(`origin/${branch}`))
    return run(["worktree", "add", "-b", branch, path, `origin/${branch}`]);
  return run(["worktree", "add", "-b", branch, path, baseRef]);
}

/** Remove a worktree. Not forced by default — fails if it has uncommitted changes,
 *  which is what `land` wants. Pass `{ force: true }` to remove regardless (an
 *  aborted session via `stop` discards its in-progress work rather than waiting
 *  for a clean tree). */
export function worktreeRemove(path: string, opts?: { force?: boolean }): Promise<GitResult> {
  const args = ["worktree", "remove", path];
  if (opts?.force) args.push("--force");
  return run(args);
}
