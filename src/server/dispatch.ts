import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { SessionKind, SessionState, TaskStatus } from "../shared/types.ts";
import { db } from "./db.ts";
import { pullMain } from "./git.ts";
import { type Phase, type Session, type Task, phases, sessions, tasks } from "./schema.ts";
import { linkSessionTasks } from "./session-tasks.ts";

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

/** A task paired with its live, ordered phases — the unit `buildTaskPrompt`
 *  stitches into one worker brief. */
export type TaskBrief = { task: Task; phases: Phase[] };

/** One task's section of the combined brief: its title, phase checklist, and the
 *  PM-Phase trailers that stamp each finished phase. */
function taskSection(task: Task, taskPhases: Phase[]): string {
  const phaseLines = taskPhases.map((p) => `- ${p.name}`).join("\n");
  const trailers = taskPhases.map((p) => `PM-Phase: ${p.id}   # ${p.name}`);
  return [
    `Task: ${task.title}`,
    "",
    "Phases:",
    phaseLines,
    "",
    "Phase trailers — add each to the commit that completes that phase:",
    ...trailers,
  ].join("\n");
}

/** Build the full worker prompt + per-phase trailer lines for one or more tasks.
 *  Shared by start-local and dispatch so a worker — local or remote — gets
 *  identical instructions and the same PM-Phase trailers to stamp finished phases
 *  with; reconciliation reads those trailers back once the branch lands on main.
 *
 *  Several tasks can be handed to a single worker: each gets its own titled
 *  section with its own phases + trailers, and the worker stamps whichever phase
 *  it just finished. `trailers` is the flat list across every task (the union of
 *  all phases), in task-then-phase order. We don't dictate a branch name — the
 *  PR↔task link comes from the PM-Phase trailers, not the branch. */
export function buildTaskPrompt(briefs: TaskBrief[]): { prompt: string; trailers: string[] } {
  if (briefs.length === 0) return { prompt: "", trailers: [] };

  const trailers = briefs.flatMap(({ phases: ps }) =>
    ps.map((p) => `PM-Phase: ${p.id}   # ${p.name}`),
  );
  const multi = briefs.length > 1;

  const sections = briefs.map(({ task, phases: ps }) => taskSection(task, ps));

  const header = multi
    ? [
        `You have ${briefs.length} tasks to complete in this single session. Work through`,
        "them in order; each task below lists its own phases and PM-Phase trailers.",
        "",
      ]
    : [];

  const prompt = [
    ...header,
    sections.join("\n\n"),
    "",
    // We don't dictate the branch name. The cloud workspace puts the worker on its
    // own harness branch (e.g. `claude/…`) and they stay on it; a local worker is
    // already on its worktree branch. Either way the PR↔task link comes from the
    // PM-Phase trailers above — the same trailers reconciliation reads — not the
    // branch name. (The workspace handles push/PR auth via the Claude GitHub App;
    // see README.) So just: do the work and open a PR.
    "Work on whatever branch the workspace puts you on, and open a PR against main when done.",
    "",
    "Follow the `powdermonkey` skill. As you finish each phase, add its trailer to",
    "the commit that completes it (this is how progress — and this PR — is tied back",
    "to the task, so don't skip them; they're read off the commits once they land on main).",
    "",
    "Ask any questions you have, at any time — if something's ambiguous or you hit a",
    "decision worth the operator's call, post your question on the PR thread rather than",
    "guessing. The operator watches the thread and will reply there.",
  ].join("\n");
  return { prompt, trailers };
}

/** Fetch one or more tasks + their live (non-archived, ordered) phases and build
 *  the combined prompt and trailers. Accepts a single task id or a list, and
 *  returns the resolved tasks (in the given order) alongside the brief. Returns
 *  null when the list is empty or any task doesn't exist. The single place that
 *  loads a task's phases for prompting — start-local, dispatch and the
 *  `GET /tasks/:id/prompt` route all go through here. */
export async function loadTaskPrompt(
  taskIds: number | number[],
): Promise<{ prompt: string; trailers: string[]; tasks: Task[] } | null> {
  const ids = Array.isArray(taskIds) ? taskIds : [taskIds];
  if (ids.length === 0) return null;

  const briefs: TaskBrief[] = [];
  for (const id of ids) {
    const [task] = await db.select().from(tasks).where(eq(tasks.id, id));
    if (!task) return null;
    const taskPhases = await db
      .select()
      .from(phases)
      .where(and(eq(phases.taskId, id), isNull(phases.archivedAt)))
      .orderBy(asc(phases.position));
    briefs.push({ task, phases: taskPhases });
  }

  return { ...buildTaskPrompt(briefs), tasks: briefs.map((b) => b.task) };
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

/** Dispatch one or more tasks as a SINGLE `claude --remote` session against main.
 *  All selected tasks share the one cloud run (the combined brief lists each), and
 *  each surfaces that session. The first task is the "primary" — it names the
 *  prompt file and the dry-run URL. */
export async function dispatchTask(taskIds: number | number[]): Promise<DispatchResult> {
  const built = await loadTaskPrompt(taskIds);
  if (!built) return { ok: false, error: `unknown task "${[taskIds].flat().join(", ")}"` };
  const ids = built.tasks.map((t) => t.id);
  const primary = ids[0];

  // Know the repo's current state before dispatching. A non-ff pull is logged
  // but not fatal — dispatch still execs against main in the cloud.
  const pull = await pullMain();
  if (!pull.ok) console.warn(`git pull (non-fatal): ${pull.output}`);

  const { prompt } = built;
  let output: string;

  if (process.env.PM_DISPATCH_DRY_RUN) {
    output = `Created cloud session\nView: https://claude.ai/code/dry-run-${primary}`;
  } else {
    // Stash the prompt in a file so a multi-line prompt never has to survive shell
    // quoting, then run the dispatch command in a PTY (claude needs a TTY).
    const dir = join(repoDir(), "data", "prompts");
    mkdirSync(dir, { recursive: true });
    const promptPath = join(dir, `dispatch-${primary}.md`);
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
  // One session row, linked to every dispatched task via the session_tasks join, so
  // each task surfaces the shared cloud run. Each task is also marked dispatched.
  const [session] = await db
    .insert(sessions)
    .values({ kind: SessionKind.Remote, state: SessionState.Running, url: sessionUrl })
    .returning();
  await linkSessionTasks(session.id, ids);
  await db
    .update(tasks)
    .set({
      sessionUrl,
      status: TaskStatus.Dispatched,
      sessionState: SessionState.Running,
      updatedAt: new Date(),
    })
    .where(inArray(tasks.id, ids));

  return { ok: true, sessionUrl, session };
}
