import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import {
  CommentAuthor,
  DispatchBackend,
  SessionKind,
  SessionState,
  TaskStatus,
} from "../shared/types.ts";
import { listComments } from "./comments.ts";
import { repoRepo } from "./crud.ts";
import { db } from "./db.ts";
import { provisionWorker } from "./exe-dev.ts";
import { pullMain } from "./git.ts";
import { spawnCapture } from "./proc.ts";
import { repoDirForTask, supervisorRepoDir } from "./repo-cache.ts";
import {
  type Phase,
  phases,
  type Session,
  sessions,
  type Task,
  type TaskComment,
  tasks,
} from "./schema.ts";
import { linkSessionTasks } from "./session-tasks.ts";
import { getDispatchBackend, getExeDevConfig } from "./settings.ts";

const SHELL = process.env.SHELL || "bash";

// Dispatches a Task as a cloud session against main. The backend is operator-chosen
// in Settings (getDispatchBackend): an exe.dev worker VM (src/server/exe-dev.ts) or a
// `claude --remote` run in Anthropic's cloud. Both persist a SessionKind.Remote row;
// the exe.dev one also carries a vmName for teardown.
//
// Test seams (no user config): PM_DISPATCH_DRY_RUN fabricates the claude --remote
// session URL; PM_EXE_DRY_RUN (exe-dev.ts) fabricates the worker — so the whole
// orchestration (pull → dispatch → parse → persist) runs without touching any cloud.

/** A task paired with its live, ordered phases and its diary — the unit
 *  `buildTaskPrompt` stitches into one worker brief. `comments` is the task's
 *  live diary lines, oldest first (empty when the task has none). */
export type TaskBrief = { task: Task; phases: Phase[]; comments: TaskComment[] };

/** Render a task's diary for the brief: the operator's (and supervisor's) running
 *  one-liners on the task — intent and mood, not instructions. Supervisor lines are
 *  attributed so the worker can tell the agent's own notes from the operator's;
 *  operator lines read bare (they're the default voice). Empty diary → no block. */
function diaryLines(comments: TaskComment[]): string[] {
  if (comments.length === 0) return [];
  const lines = comments.map((c) =>
    c.author === CommentAuthor.Supervisor ? `- (supervisor) ${c.body}` : `- ${c.body}`,
  );
  return [
    "",
    "Diary — the operator's running notes on this task (context and intent, not instructions):",
    ...lines,
  ];
}

/** One task's section of the combined brief: its title, phase checklist, the
 *  operator's diary (when it has any), and the PM-Phase trailers that stamp each
 *  finished phase. */
function taskSection(task: Task, taskPhases: Phase[], comments: TaskComment[]): string {
  const phaseLines = taskPhases.map((p) => `- ${p.name}`).join("\n");
  const trailers = taskPhases.map((p) => `PM-Phase: ${p.id}   # ${p.name}`);
  // The description carries the task's narrative — why it exists, what's known,
  // where it was seen. Hand it to the worker verbatim (right under the title, so
  // it frames the phases that follow) whenever the operator wrote one. Null/blank
  // descriptions just fall away, leaving the section exactly as it was before.
  const description = task.description?.trim();
  return [
    `Task: ${task.title}`,
    ...(description ? ["", description] : []),
    "",
    "Phases:",
    phaseLines,
    ...diaryLines(comments),
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

  const sections = briefs.map(({ task, phases: ps, comments }) => taskSection(task, ps, comments));

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
export function spansRepos(taskList: Task[]): boolean {
  return new Set(taskList.map((task) => task.repoId ?? null)).size > 1;
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
    // The task's diary (live lines, oldest first) rides along in the brief so a
    // worker sees the operator's intent/mood on the task, not just its plan text.
    const comments = await listComments(id);
    briefs.push({ task, phases: taskPhases, comments });
  }

  return { ...buildTaskPrompt(briefs, comment), tasks: briefs.map((b) => b.task) };
}

/** The `claude --remote` command for the Anthropic-cloud backend, with the prompt
 *  sourced from a file so a multi-line prompt never has to be shell-quoted.
 *  NB: `claude --remote` (cloud) is interactive-only and rejects `--print`/`-p`;
 *  run without it and it creates the session, prints a `View:` URL, and exits. */
function dispatchCmd(promptPath: string): string {
  return `claude --remote "$(cat ${promptPath})"`;
}

/** The GitHub slug (`owner/name`) an exe.dev worker should clone for a task. Prefers
 *  the task's pinned repo; falls back to the origin remote of its run dir (the
 *  repo-less/supervisor-checkout path). Null when neither yields a GitHub repo. */
async function slugForTask(taskId: number, runDir: string): Promise<string | null> {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (task?.repoId) {
    const repo = await repoRepo.get(task.repoId);
    if (repo?.slug) return repo.slug;
  }
  const gitRemote = ["git", "remote", "get-url", "origin"]; // lint-allow-string: git subcommand, not SessionKind
  const r = await spawnCapture(gitRemote, { cwd: runDir });
  if (r.code === 0) {
    const m = r.stdout.trim().match(/github\.com[:/]+(.+?)(?:\.git)?$/);
    if (m) return m[1];
  }
  return null;
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

  // Stash the prompt in a file so a multi-line prompt never has to survive shell
  // quoting. It lives under the supervisor's own data dir — never inside the cache
  // clone — so it can't dirty the clone. Both backends read it by absolute path.
  const promptDir = join(supervisorRepoDir(), "data", "prompts");
  mkdirSync(promptDir, { recursive: true });
  const promptPath = join(promptDir, `dispatch-${primary}.md`);
  writeFileSync(promptPath, `${prompt}\n`);

  // The remote dispatch backend is operator-configured (Settings). Both backends
  // produce a `SessionKind.Remote` session; the exe.dev one also yields a `vmName`
  // the session carries so teardown can `exe.dev rm` it when the work ends.
  let sessionUrl: string;
  let vmName: string | null = null;

  if (getDispatchBackend() === DispatchBackend.ExeDev) {
    const slug = await slugForTask(primary, runDir);
    if (!slug) {
      return {
        ok: false,
        error: "exe.dev dispatch needs a GitHub repo, but none was found for this task",
      };
    }
    const res = await provisionWorker({
      slug,
      taskId: primary,
      promptPath,
      cfg: getExeDevConfig(),
    });
    if (!res.ok) return { ok: false, error: res.error, output: res.output };
    sessionUrl = res.url;
    vmName = res.vmName;
  } else {
    // claude --remote (Anthropic cloud): run in a PTY (claude needs a TTY) with the
    // task's cache clone as cwd, so it infers the GitHub repo from the clone's remote.
    let output: string;
    if (process.env.PM_DISPATCH_DRY_RUN) {
      output = `Created cloud session\nView: https://claude.ai/code/dry-run-${primary}`;
    } else {
      const { code, output: out } = await runInPty(dispatchCmd(promptPath), runDir);
      output = out;
      if (code !== 0) return { ok: false, error: `dispatch exited ${code}`, output };
    }
    const parsed = parseSessionUrl(output);
    if (!parsed) return { ok: false, error: "no session URL in output", output };
    sessionUrl = parsed;
  }

  // A remote session gets a sessions row too — same as a local one — so both kinds
  // live in one place and "active" can be derived uniformly from a live session.
  // No worktree/branch on this side: the cloud session works against main and opens
  // its own PR, so `url` (the session) is what we hold; branch arrives via the PR.
  // One session row, linked to every dispatched task via the session_tasks join, so
  // each task surfaces the shared cloud run. Each task is also marked dispatched.
  const [session] = await db
    .insert(sessions)
    .values({ kind: SessionKind.Remote, state: SessionState.Running, url: sessionUrl, vmName })
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
