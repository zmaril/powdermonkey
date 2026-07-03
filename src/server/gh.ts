// The one place we shell out to the GitHub CLI. There's no persistent server
// endpoint to hang a webhook off, so a localhost supervisor drives GitHub through
// the operator's already-authed `gh`.
//
// Two readers/writers share this seam: github-watch.ts polls PR state and runs the
// @claude remote-control channel (a comment tagging `@claude` on a task's PR wakes a
// live `claude --remote` worker), and pr-review.ts reads diffs/comments and posts
// inline review comments. Keeping the spawn here means there's a single seam to
// fake in tests (PM_PR_FIXTURE_DIR, see pr-review.ts). There is deliberately no
// "the repo" here: every caller names the repo it's talking to (the registry is
// the source of repos — see docs/vocabulary.md).

import { spawnCapture } from "./proc.ts";

export type GhResult = { ok: boolean; stdout: string; stderr: string };

/** Run `gh <args>` and capture stdout/stderr. Never throws — a missing `gh`, no
 *  auth, or a non-zero exit all come back as `{ ok: false }` for the caller to
 *  handle (the watcher keeps last-known state; the review routes 502). Pass `stdin`
 *  to feed a request body (e.g. `gh api … --input -` for a JSON review payload). */
export async function gh(args: string[], stdin?: string): Promise<GhResult> {
  try {
    const { code, stdout, stderr } = await spawnCapture(["gh", ...args], { stdin });
    return { ok: code === 0, stdout, stderr };
  } catch (e) {
    // `gh` not on PATH (e.g. a stripped container) — Bun.spawn throws synchronously.
    return { ok: false, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
}

// ---- the @claude remote-control channel ------------------------------------
// A comment tagging `@claude` on a task's PR thread is how the supervisor talks to a
// *live cloud session* with no web UI: `claude --remote` workers watch their PR, and
// a tagged comment wakes one and feeds it an instruction (e.g. "rebase"). This is the
// write side of that channel; github-watch.ts is the read side (polling PR state).

/** The `gh pr comment` argv for posting `body` on PR `prNumber`. Pure — split out
 *  so the arg shape (repo flag placement, number stringification) is unit-testable
 *  without spawning. `repo` ("owner/name") targets a PR outside the cwd's repo. */
export function commentArgs(prNumber: number, body: string, repo?: string): string[] {
  const args = ["pr", "comment", String(prNumber)];
  if (repo) args.push("--repo", repo);
  args.push("--body", body);
  return args;
}

/** Post a comment on a PR thread. Resolves to gh's `{ ok, stdout, stderr }` — a
 *  non-ok result is left for the caller to log/ignore (a failed comment must not
 *  crash the watcher loop that triggers it). */
export async function commentOnPr(
  prNumber: number,
  body: string,
  repo?: string,
): Promise<GhResult> {
  return gh(commentArgs(prNumber, body, repo));
}

/** Tag a message at `@claude`. Pure; trims so the marker leads the comment, which
 *  is what a `claude --remote` worker watches its PR thread for. */
export function claudeMessage(message: string): string {
  return `@claude ${message.trim()}`;
}

/** Comment on a task's PR thread tagging `@claude` — the remote-control channel
 *  into a live cloud session. `message` is the instruction (no need to include the
 *  tag yourself). Returns gh's result so the caller can tell whether the ask landed. */
export async function askClaude(
  prNumber: number,
  message: string,
  repo?: string,
): Promise<GhResult> {
  return commentOnPr(prNumber, claudeMessage(message), repo);
}
