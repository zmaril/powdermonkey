// The spawn+capture core shared by the `gh` and `git` seams: run a command, read
// stdout/stderr to completion, hand back the exit code. Each caller layers its own
// error policy and result shape on top — gh (gh.ts) swallows a missing binary and
// keeps the streams separate; git (git.ts) merges and trims them. Kept in one place
// so "how we shell out" has a single definition.
export type Captured = { code: number; stdout: string; stderr: string };

export async function spawnCapture(
  cmd: string[],
  opts: { cwd?: string; stdin?: string; env?: Record<string, string> } = {},
): Promise<Captured> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    stdin: opts.stdin != null ? new Blob([opts.stdin]) : undefined,
    // Merge over the inherited environment — callers layer git identity / index
    // overrides on top without dropping PATH and the rest (see git plumbing).
    env: opts.env ? { ...process.env, ...opts.env } : undefined,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}
