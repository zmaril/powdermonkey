import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import { SessionKind, SessionState, TaskStatus } from "../shared/types.ts";
import { db } from "./db.ts";
import { CROSS_REPO_ERROR, loadTaskPrompt, spansRepos } from "./dispatch.ts";
import { worktreeAdd, worktreeAddRemote, worktreeRemove } from "./git.ts";
import { type Session, sessions, tasks } from "./schema.ts";
import { killSessionPty, startSessionPty } from "./session-pty.ts";
import { linkSessionTasks, taskIdsForSession } from "./session-tasks.ts";

// A local session is the on-laptop mirror of `claude --remote`: an isolated git
// worktree on `pm/task-<id>`, branched off main, where work happens without
// touching the supervisor's main checkout. When the branch lands on main with
// PM-Phase trailers, reconciliation marks the work done — same as a cloud session.

const MAIN_BRANCH = process.env.PM_MAIN_BRANCH ?? "main";

function worktreeBase(): string {
  const repo = process.env.PM_REPO_DIR ?? process.cwd();
  return process.env.PM_WORKTREE_DIR ?? join(repo, "..", "pm-worktrees");
}

/** The on-disk worktree path a task's local session lives in. */
function worktreePathFor(taskId: number): string {
  return join(worktreeBase(), `task-${taskId}`);
}

// Where per-session prompt files live (outside any worktree so the agent never
// commits them). The startup command can `cat` this to seed the session.
function promptDir(): string {
  const repo = process.env.PM_REPO_DIR ?? process.cwd();
  return join(repo, "data", "prompts");
}

// The command the session's PTY runs in the worktree. By default we hand the
// generated prompt (task + phases + trailer block) straight to `claude` as its
// opening message, so the worker knows what to build and starts immediately —
// no copy/paste. The `{prompt_file}` placeholder is replaced with the absolute
// prompt path; set PM_SESSION_CMD to override (e.g. PM_SESSION_CMD='claude' for a
// bare session where you paste the prompt yourself).
function sessionStartup(promptPath: string, override?: string): string {
  const tmpl = override ?? process.env.PM_SESSION_CMD ?? `claude "$(cat {prompt_file})"`;
  return tmpl.replaceAll("{prompt_file}", promptPath);
}

/** Overrides for a non-default local session. Plain `start-local` passes none and
 *  gets a fresh `pm/task-<id>` branch off main running the task prompt. Teleport
 *  passes a discovered cloud branch (fetched from the remote) and a
 *  `claude --teleport` startup. */
export type StartLocalOpts = {
  // Branch to check out (default `pm/task-<id>`).
  branch?: string;
  // When true, `branch` may live only on the remote — fetch + check it out rather
  // than cutting a fresh branch off main.
  fetchRemote?: boolean;
  // Startup command template (overrides PM_SESSION_CMD); `{prompt_file}` is replaced.
  startup?: string;
  // Optional operator note for this run, appended to the worker's prompt.
  comment?: string;
};

export type StartLocalResult =
  | {
      ok: true;
      session: Session;
      worktreePath: string;
      branch: string;
      prompt: string;
      trailers: string[];
    }
  | { ok: false; error: string; output?: string };

export async function startLocalSession(
  taskIds: number | number[],
  opts: StartLocalOpts = {},
): Promise<StartLocalResult> {
  const built = await loadTaskPrompt(taskIds, opts.comment);
  if (!built) return { ok: false, error: `unknown task "${[taskIds].flat().join(", ")}"` };
  if (spansRepos(built.tasks)) return { ok: false, error: CROSS_REPO_ERROR };
  const { prompt, trailers } = built;
  const ids = built.tasks.map((t) => t.id);
  const primary = ids[0];

  // One worktree + branch for all selected tasks, named after the primary task.
  const branch = opts.branch ?? `pm/task-${primary}`;
  const worktreePath = worktreePathFor(primary);
  mkdirSync(worktreeBase(), { recursive: true });

  const add = opts.fetchRemote
    ? await worktreeAddRemote(worktreePath, branch, MAIN_BRANCH)
    : await worktreeAdd(worktreePath, branch, MAIN_BRANCH);
  if (!add.ok) return { ok: false, error: "git worktree add failed", output: add.output };

  // One session row for all the tasks, linked through the session_tasks join; each
  // task is marked dispatched so the whole batch moves to Active together.
  const [session] = await db
    .insert(sessions)
    .values({ kind: SessionKind.Local, state: SessionState.Running, branch, worktreePath })
    .returning();
  await linkSessionTasks(session.id, ids);
  await db
    .update(tasks)
    .set({ status: TaskStatus.Dispatched, updatedAt: new Date() })
    .where(inArray(tasks.id, ids));

  // Stash the prompt where the startup command can reach it, then bring up the
  // session's persistent interactive PTY in the worktree. Clients attach to this
  // via /pty?session=<id>; it outlives any single browser connection.
  mkdirSync(promptDir(), { recursive: true });
  const promptPath = join(promptDir(), `session-${session.id}.md`);
  writeFileSync(promptPath, `${prompt}\n`);
  startSessionPty(session.id, worktreePath, sessionStartup(promptPath, opts.startup));

  return { ok: true, session, worktreePath, branch, prompt, trailers };
}

export type LandResult =
  | { ok: true; session: Session }
  | { ok: false; error: string; output?: string };

/** Tear down a local session's worktree and archive the session row. The actual
 *  merge of its branch into main is a normal git action; reconciliation then reads
 *  the trailers off main. Fails if the worktree has uncommitted changes. */
export async function landSession(sessionId: number): Promise<LandResult> {
  const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
  if (!session) return { ok: false, error: `unknown session "${sessionId}"` };

  // Tear down the live PTY (if any) before removing its worktree out from under it.
  killSessionPty(sessionId);

  if (session.worktreePath) {
    const rm = await worktreeRemove(session.worktreePath);
    if (!rm.ok) {
      return {
        ok: false,
        error: "git worktree remove failed (commit or clean the worktree first)",
        output: rm.output,
      };
    }
  }

  const [updated] = await db
    .update(sessions)
    .set({ state: SessionState.Idle, archivedAt: new Date(), updatedAt: new Date() })
    .where(eq(sessions.id, sessionId))
    .returning();
  return { ok: true, session: updated };
}

export type StopResult =
  | { ok: true; session: Session }
  | { ok: false; error: string; output?: string };

/** Abort a session that's still running. Unlike `land` (graceful teardown of
 *  *finished* work, which refuses a dirty worktree), `stop` is the kill switch: it
 *  tears the agent down without requiring a clean tree, records the session as
 *  `stopped` + archived, and rolls its still-in-flight tasks back to `pending` so
 *  they can be re-run. Tasks that already reached a terminal status (`merged` —
 *  done — or `cancelled` — won't-do) are left alone: a session spanning several
 *  tasks may be aborted long after one of them merged, and stopping the shared
 *  session must not un-merge that finished work.
 *
 *  - local: kill the agent's tmux/PTY, then force-remove its worktree (discarding
 *    any in-progress work) so a re-run can recreate it at the same path.
 *  - remote: we can't reach the cloud run from here, so all we can do is record it
 *    as stopped; the operator stops the actual run in the Claude web UI. */
export async function stopSession(sessionId: number): Promise<StopResult> {
  const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
  if (!session) return { ok: false, error: `unknown session "${sessionId}"` };

  if (session.kind === SessionKind.Local) {
    // Kill the live agent first, then drop its worktree out from under it. The
    // force-remove can still fail (e.g. the path is already gone); that's logged
    // but never blocks the abort — the point is to stop the agent, not to garbage
    // collect perfectly.
    killSessionPty(sessionId);
    if (session.worktreePath) {
      const rm = await worktreeRemove(session.worktreePath, { force: true });
      if (!rm.ok) console.warn(`stop: worktree remove (non-fatal): ${rm.output}`);
    }
  }

  const [updated] = await db
    .update(sessions)
    .set({ state: SessionState.Stopped, archivedAt: new Date(), updatedAt: new Date() })
    .where(eq(sessions.id, sessionId))
    .returning();

  // Roll every still-in-flight task this session was working back to pending so
  // they're dispatchable again, and clear the runtime session fields that pointed
  // at this aborted run (a remote session set these). Terminal tasks (merged /
  // cancelled) are excluded by the status guard: aborting a shared session must
  // never regress already-finished work back to pending.
  const taskIds = await taskIdsForSession(sessionId);
  if (taskIds.length > 0) {
    await db
      .update(tasks)
      .set({
        status: TaskStatus.Pending,
        sessionState: null,
        sessionUrl: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          inArray(tasks.id, taskIds),
          notInArray(tasks.status, [TaskStatus.Merged, TaskStatus.Cancelled]),
        ),
      );
  }

  return { ok: true, session: updated };
}
