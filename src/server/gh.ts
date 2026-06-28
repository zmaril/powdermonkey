// The `gh` CLI seam. PowderMonkey shells out to the GitHub CLI for the few writes
// it needs — there's no persistent server endpoint to hang a webhook off, so a
// localhost supervisor drives GitHub through the operator's already-authed `gh`.
//
// The headline use is the @claude channel: a comment tagging `@claude` on a task's
// PR thread is how the supervisor talks to a *live cloud session* with no web UI.
// `claude --remote` workers watch their PR; a tagged comment wakes one and feeds it
// an instruction (e.g. "rebase"). This module is the write side of that channel;
// github-watch.ts is the read side (polling PR state).

/** Run `gh <args>`, capturing stdout/stderr. `ok` is exit-code 0. Never throws —
 *  callers decide what a non-ok result means (no `gh`, no auth, network blip). */
export async function gh(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { ok: code === 0, stdout, stderr };
}

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
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
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
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return commentOnPr(prNumber, claudeMessage(message), repo);
}
