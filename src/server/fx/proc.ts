// A child process as Effect — Bun.spawn collected to {ok,out,err,code}.
import { Effect } from "effect";
import { SpawnError } from "./errors.ts";

export interface ProcOut {
  ok: boolean;
  out: string;
  err: string;
  code: number;
}

export const run = (
  argv: string[],
  opts?: { cwd?: string; env?: Record<string, string | undefined> },
): Effect.Effect<ProcOut, SpawnError> =>
  Effect.tryPromise({
    try: async () => {
      const p = Bun.spawn(argv, {
        cwd: opts?.cwd,
        env: opts?.env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ]);
      return { ok: code === 0, out, err, code };
    },
    catch: (cause) => new SpawnError({ cause }),
  });
