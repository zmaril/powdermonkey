// git as Effect — the Bun.spawn driver boundary wrapped once.
import { Effect } from "effect";
import { GitError } from "./errors.ts";

export interface GitOut {
  ok: boolean;
  out: string;
}

export const git = (args: string[]): Effect.Effect<GitOut, GitError> =>
  Effect.tryPromise({
    try: async () => {
      const p = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ]);
      return { ok: code === 0, out: code === 0 ? out : out + err };
    },
    catch: (cause) => new GitError({ args, cause }),
  });

export const gitHead = (repoPath: string): Effect.Effect<string, GitError> =>
  git(["-C", repoPath, "rev-parse", "--abbrev-ref", "HEAD"]).pipe(
    Effect.map((r) => r.out.trim() || "HEAD"),
  );
