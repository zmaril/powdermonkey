import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { SessionKind, SessionState, TaskStatus } from "../shared/types.ts";
import { db } from "./db.ts";
import { pullMain } from "./git.ts";
import { repoDirForTask, supervisorRepoDir } from "./repo-cache.ts";
import { type Phase, phases, type Session, sessions, type Task, tasks } from "./schema.ts";
import { linkSessionTasks } from "./session-tasks.ts";

const SHELL = process.env.SHELL || "bash";

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
 *  PR<->task link comes from the PM-Phase trailers, not the branch. */
export function buildTaskPrompt(
  briefs: TaskBrief[],
  comment?: string,
): { prompt: string; trailers: string[] } {
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

  const lines = [
    ...header,
    sections.join("\n\n"),
    "",
    // We don't dictate the branch name. The cloud workspace puts the worker on its
    // own harness branch (e.g. `claude/…`) and they stay on it; a local worker is
    // already on its worktree branch. Either way the PR<->task link comes from the
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
  ];
  // Optional operator note typed at launch — extra context for THIS run, appended last
  // so it's the freshest instruction the worker sees.
  const note = comment?.trim();
  if (note) lines.push("", "Operator note for this run:", note);
  const prompt = lines.join("\n");
  return { prompt, trailers };
}

/** The message both launch paths return when a multi-select spans repos. */
export const CROSS_REPO_ERROR =
  "cross-repo launch: the selected tasks target different repos — a session runs one repo, so launch each repo's tasks separately (or author cross-repo work via the task fan-out)";

/** True when these tasks don't all target the same repo. One launch is ONE session,
 *  and a session is ONE environment — it clones a single repo — so a multi-select that
 *  spans repos can't be dispatched together. Tasks that agree on a repo (including a set
 *  that's uniformly repo-less) pass; a null repo is its own bucket, so mixing a repo-less
 *  task with a repo-pinned one is treated as cross-repo. The API rejects this and the UI
 *  blocks the selection — cross-repo work is authored via the task fan-out instead. */
export function spansRepos(tasks: Task[]): boolean {
  return new Set(tasks.map((t) => t.repoId ?? null)).size > 1;
}

/** Fetch one or more tasks + their live (non-archived, ordered) phases and build
 *  the combined prompt and trailers. Accepts a single task id or a list, and
 *  returns the resolved tasks (in the given order) alongside the brief. Returns
 *  null when the list is empty or any task doesn't exist. The single place that
 *  loads a task's phases for prompting — start-local, dispatch and the
 *  `GET /tasks/:id/prompt` route all go through here. */
export async function loadTaskPrompt(
  taskIds: number | number[],
  comment?: string,
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

  return { ...buildTaskPrompt(briefs, comment), tasks: briefs.map((b) => b.task) };
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
function runInPty(launch: string, cwd: string): Promise<{ code: number; output: string }> {
  let buf = "";
  const options = {
    cwd,
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
export async function dispatchTask(
  taskIds: number | number[],
  comment?: string,
): Promise<DispatchResult> {
  const built = await loadTaskPrompt(taskIds, comment);
  if (!built) return { ok: false, error: `unknown task "${[taskIds].flat().join(", ")}"` };
  if (spansRepos(built.tasks)) {
    return { ok: false, error: CROSS_REPO_ERROR };
  }
  const ids = built.tasks.map((t) => t.id);
  const primary = ids[0];

  // Resolve the repo this task runs in and make its cache clone current: dispatch's
  // PTY runs with that clone as cwd, so `claude --remote` infers the right GitHub
  // repo from its remote (no repo flag needed). A clone we can't produce is fatal —
  // there'd be no working tree to infer the repo from. A repo-less task falls back to
  // the supervisor's own checkout (repoDirForTask), preserving single-repo behavior.
  const resolved = await repoDirForTask(primary, { ensure: true });
  if (resolved.error) {
    return {
      ok: false,
      error: `repo cache unavailable: ${resolved.error}`,
      output: resolved.output,
    };
  }
  const runDir = resolved.dir;

  // Know the repo's current state before dispatching. A per-repo cache clone was just
  // fetched by ensureRepo; for the supervisor-repo fallback, pull main here instead. A
  // non-ff pull is logged but not fatal — dispatch still execs against main in the cloud.
  if (runDir === supervisorRepoDir()) {
    const pull = await pullMain();
    if (!pull.ok) console.warn(`git pull (non-fatal): ${pull.output}`);
  }

  const { prompt } = built;
  let output: string;

  if (process.env.PM_DISPATCH_DRY_RUN) {
    output = `Created cloud session\nView: https://claude.ai/code/dry-run-${primary}`;
  } else {
    // Stash the prompt in a file so a multi-line prompt never has to survive shell
    // quoting, then run the dispatch command in a PTY (claude needs a TTY) with the
    // task's cache clone as cwd. The prompt file lives under the supervisor's own data
    // dir — never inside the cache clone — so it can't dirty the clone. Its absolute
    // path is fed to `cat`, so cwd being the clone doesn't matter for reading it.
    const dir = join(supervisorRepoDir(), "data", "prompts");
    mkdirSync(dir, { recursive: true });
    const promptPath = join(dir, `dispatch-${primary}.md`);
    writeFileSync(promptPath, `${prompt}\n`);
    const { code, output: out } = await runInPty(dispatchCmd(promptPath), runDir);
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
