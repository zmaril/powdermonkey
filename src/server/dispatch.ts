import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "./db.ts";
import { pullMain } from "./git.ts";
import { type Phase, type Session, type Task, phases, sessions, tasks } from "./schema.ts";

const SHELL = process.env.SHELL || "bash";

function repoDir(): string {
  return process.env.PM_REPO_DIR ?? process.cwd();
}

// Dispatches a Task as a `claude --remote` session against main.
//
// ┌─ SEAM: confirm against your spike ──────────────────────────────────────┐
// │ Two things here are the externally-defined contract that the spike       │
// │ pinned down, not something this code can verify on its own:              │
// │   1. the exact argv that starts a remote session with a prompt           │
// │   2. how the session URL appears in the command's output                 │
// │ Both are overridable via env so the defaults can be corrected without    │
// │ touching code. Set PM_DISPATCH_DRY_RUN=1 to exercise the orchestration   │
// │ (pull → spawn → parse → persist) without touching the cloud.             │
// └──────────────────────────────────────────────────────────────────────────┘

/** Build the full worker prompt + per-phase trailer lines for a task. Shared by
 *  start-local and dispatch so a worker — local or remote — gets identical
 *  instructions and the same PM-Phase trailers to stamp finished phases with;
 *  reconciliation reads those trailers back once the branch lands on main. */
export function buildTaskPrompt(
  task: Task,
  taskPhases: Phase[],
): { prompt: string; trailers: string[] } {
  const phaseLines = taskPhases.map((p) => `- ${p.name}`).join("\n");
  // Per-phase trailer lines so each finished phase can stamp its commit.
  const trailers = taskPhases.map((p) => `PM-Phase: ${p.id}   # ${p.name}`);
  const prompt = [
    `Task: ${task.title}`,
    "",
    "Phases:",
    phaseLines,
    "",
    "Work against main and open a pull request when done.",
    "",
    "Follow the `powdermonkey` skill. As you finish each phase, add its trailer to",
    "the commit that completes it (progress is read off these once they land on main):",
    ...trailers,
  ].join("\n");
  return { prompt, trailers };
}

/** Fetch a task + its live (non-archived, ordered) phases and build the prompt
 *  and trailers. Returns null when the task doesn't exist. The single place that
 *  loads a task's phases for prompting — start-local, dispatch and the
 *  `GET /tasks/:id/prompt` route all go through here. */
export async function loadTaskPrompt(
  taskId: number,
): Promise<{ prompt: string; trailers: string[] } | null> {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task) return null;

  const taskPhases = await db
    .select()
    .from(phases)
    .where(and(eq(phases.taskId, taskId), isNull(phases.archivedAt)))
    .orderBy(asc(phases.position));

  return buildTaskPrompt(task, taskPhases);
}

/** The dispatch command, with the prompt sourced from a file so a multi-line
 *  prompt never has to be shell-quoted. `{prompt_file}` is replaced with the path.
 *  NB: `claude --remote` (cloud) is interactive-only and rejects `--print`/`-p`;
 *  run without it and it creates the session, prints a `View:` URL, and exits. */
function dispatchCmd(promptPath: string): string {
  const tmpl = process.env.PM_DISPATCH_CMD ?? `claude --remote "$(cat {prompt_file})"`;
  return tmpl.replaceAll("{prompt_file}", promptPath);
}

/** Run a command in a PTY and collect its output until it exits. `claude` needs a
 *  TTY: spawned with plain pipes it falls back to a bundled `cli.js` under whatever
 *  `node` is on PATH (which may be an unsupported version that crashes on startup).
 *  Given a real terminal it uses its own runtime — same as an interactive shell.
 *  We run through a login shell so PATH/profile resolve `claude`, and DON'T fall
 *  through to an interactive shell, so the process exits once the command returns. */
function runInPty(launch: string): Promise<{ code: number; output: string }> {
  let buf = "";
  const options = {
    cwd: repoDir(),
    env: { ...process.env, TERM: "xterm-256color" },
    terminal: {
      cols: 120,
      rows: 40,
      data(_t: unknown, d: unknown) {
        buf += typeof d === "string" ? d : new TextDecoder().decode(d as Uint8Array);
      },
    },
    // biome-ignore lint/suspicious/noExplicitAny: native PTY option not typed yet.
  } as any;
  const proc = Bun.spawn([SHELL, "-l", "-c", launch], options);
  return proc.exited.then((code: number) => ({ code, output: buf }));
}

/** Pull the first URL out of the command output. The session lives at that URL.
 *  Strips ANSI control sequences first (PTY output is full of them) and stops the
 *  match at quote/escape chars so a trailing reset code can't get glued on. */
export function parseSessionUrl(output: string): string | null {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes.
  const clean = output.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
  const m = clean.match(/https?:\/\/[^\s"'\\]+/);
  return m ? m[0] : null;
}

export type DispatchResult =
  | { ok: true; sessionUrl: string; session: Session }
  | { ok: false; error: string; output?: string };

export async function dispatchTask(taskId: number): Promise<DispatchResult> {
  const built = await loadTaskPrompt(taskId);
  if (!built) return { ok: false, error: `unknown task "${taskId}"` };

  // Know the repo's current state before dispatching. A non-ff pull is logged
  // but not fatal — dispatch still execs against main in the cloud.
  const pull = await pullMain();
  if (!pull.ok) console.warn(`git pull (non-fatal): ${pull.output}`);

  const { prompt } = built;
  let output: string;

  if (process.env.PM_DISPATCH_DRY_RUN) {
    output = `Created cloud session\nView: https://claude.ai/code/dry-run-${taskId}`;
  } else {
    // Stash the prompt in a file so a multi-line prompt never has to survive shell
    // quoting, then run the dispatch command in a PTY (claude needs a TTY).
    const dir = join(repoDir(), "data", "prompts");
    mkdirSync(dir, { recursive: true });
    const promptPath = join(dir, `dispatch-${taskId}.md`);
    writeFileSync(promptPath, `${prompt}\n`);
    const { code, output: out } = await runInPty(dispatchCmd(promptPath));
    output = out;
    if (code !== 0) return { ok: false, error: `dispatch exited ${code}`, output };
  }

  const sessionUrl = parseSessionUrl(output);
  if (!sessionUrl) return { ok: false, error: "no session URL in output", output };

  // A remote session gets a sessions row too — same as a local one — so both kinds
  // live in one place and "active" can be derived uniformly from a live session.
  // No worktree/branch on this side: the cloud session works against main and opens
  // its own PR, so `url` (the session) is what we hold; branch arrives via the PR.
  const [session] = await db
    .insert(sessions)
    .values({ kind: "remote", state: "running", taskId, url: sessionUrl })
    .returning();
  await db
    .update(tasks)
    .set({ sessionUrl, status: "dispatched", sessionState: "running", updatedAt: new Date() })
    .where(eq(tasks.id, taskId));

  return { ok: true, sessionUrl, session };
}
