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

// ---- snapshot plumbing (backup-sync.ts) ------------------------------------
// Committing a backup snapshot to a durable branch without ever touching the
// operator's working tree, index, or checked-out branch. We build the commit
// entirely from the object store — `hash-object` → `mktree` → `commit-tree` →
// `update-ref` — so a snapshot lands on `refs/heads/<branch>` regardless of what
// the supervisor's checkout is doing. That's what lets autosync run on every write
// without stomping on in-progress work.

/** Like `run`, but returns raw stdout (only trimmed) so a sha isn't polluted by any
 *  stderr noise, and accepts stdin / extra env (git plumbing needs both). */
async function runIO(
  args: string[],
  opts: { cwd?: string; stdin?: string; env?: Record<string, string> } = {},
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const { code, stdout, stderr } = await spawnCapture(["git", ...args], {
    cwd: opts.cwd ?? process.env.PM_REPO_DIR ?? process.cwd(),
    stdin: opts.stdin,
    env: opts.env,
  });
  return { ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() };
}

/** Resolve a ref to its commit sha, or null if it doesn't exist. */
export async function revParse(ref: string, cwd?: string): Promise<string | null> {
  const r = await runIO(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd });
  return r.ok && r.stdout ? r.stdout : null;
}

/** A committer identity for plumbing commits. A fresh container may have no
 *  `user.name`/`user.email` configured, which makes `commit-tree` fail — so we
 *  always pass an explicit identity via env (config still wins for the operator's
 *  own commits; this only covers our synthetic backup commits). */
function botIdentity(): Record<string, string> {
  const name = "powdermonkey";
  const email = "powdermonkey@localhost";
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  };
}

/**
 * Commit `content` as a single file `fileName` (flat — no directories) onto branch
 * `branch`, from the object store alone. Chains onto the branch's current tip so the
 * branch accumulates one commit per snapshot (every change lands in git). Never
 * touches the working tree or index. Returns the new commit sha, or an error.
 *
 * `parentRef` selects what to chain onto (default `refs/heads/<branch>`); autosync
 * passes `origin/<branch>` after a fetch so the local branch tracks the remote one
 * and pushes fast-forward.
 */
export async function commitFileToBranch(opts: {
  branch: string;
  fileName: string;
  content: string;
  message: string;
  parentRef?: string;
  cwd?: string;
}): Promise<{ ok: true; sha: string } | { ok: false; error: string }> {
  const { branch, fileName, content, message, cwd } = opts;
  const env = botIdentity();

  const blob = await runIO(["hash-object", "-w", "--stdin"], { cwd, stdin: content, env });
  if (!blob.ok) return { ok: false, error: `hash-object: ${blob.stderr || blob.stdout}` };

  const tree = await runIO(["mktree"], {
    cwd,
    stdin: `100644 blob ${blob.stdout}\t${fileName}\n`,
    env,
  });
  if (!tree.ok) return { ok: false, error: `mktree: ${tree.stderr || tree.stdout}` };

  const parent = await revParse(opts.parentRef ?? `refs/heads/${branch}`, cwd);
  const commitArgs = ["commit-tree", tree.stdout, "-m", message];
  if (parent) commitArgs.push("-p", parent);
  const commit = await runIO(commitArgs, { cwd, env });
  if (!commit.ok) return { ok: false, error: `commit-tree: ${commit.stderr || commit.stdout}` };

  const ref = await runIO(["update-ref", `refs/heads/${branch}`, commit.stdout], { cwd, env });
  if (!ref.ok) return { ok: false, error: `update-ref: ${ref.stderr || ref.stdout}` };

  return { ok: true, sha: commit.stdout };
}

/** Fetch a single branch from origin (best-effort; a missing remote branch is not
 *  fatal). After this, `origin/<branch>` reflects the remote tip if it exists. */
export async function fetchBranch(branch: string, cwd?: string): Promise<GitResult> {
  return await run(["fetch", "origin", branch], cwd);
}

/** Push a local branch to origin. Tries a plain (fast-forward) push first; on
 *  rejection falls back to `--force-with-lease`, since the durable backup branch is
 *  ours to rewrite and a diverged remote tip must never wedge autosync. */
export async function pushBranch(branch: string, cwd?: string): Promise<GitResult> {
  const first = await run(["push", "origin", `${branch}:${branch}`], cwd); // lint-allow-string: git subcommand, not SyncMode.Push
  if (first.ok) return first;
  return run(["push", "--force-with-lease", "origin", `${branch}:${branch}`], cwd); // lint-allow-string: git subcommand, not SyncMode.Push
}

/** Read the contents of `path` at `ref` (e.g. `origin/<branch>:snapshot.json`) —
 *  how import pulls a snapshot straight out of a branch without a checkout. */
export async function showFile(ref: string, path: string, cwd?: string): Promise<GitResult> {
  return await run(["show", `${ref}:${path}`], cwd);
}
