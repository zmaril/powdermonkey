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

/** Remove a worktree. Not forced — fails if it has uncommitted changes, by design. */
export function worktreeRemove(path: string): Promise<GitResult> {
  return run(["worktree", "remove", path]);
}
