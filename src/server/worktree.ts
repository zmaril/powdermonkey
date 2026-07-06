import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import { match } from "ts-pattern";
import { SessionKind, SessionState, TaskStatus } from "../shared/types.ts";
import { db } from "./db.ts";
import { CROSS_REPO_ERROR, loadTaskPrompt, sessionStartup, spansRepos } from "./dispatch.ts";
import { teardownExeWorkspace } from "./exe-session.ts";
import { worktreeAdd, worktreeAddRemote, worktreeRemove } from "./git.ts";
import { repoDirForTask, supervisorRepoDir } from "./repo-cache.ts";
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

/** The repo dir that owns a session's worktree — the cache clone of its (first) task's
 *  repo, or the supervisor's own checkout when the task is repo-less. Teardown runs
 *  `git worktree remove` from here: a worktree cut from a cache clone can't be removed
 *  from the supervisor's repo. Path-only (no clone/fetch) — the clone already exists. */
async function repoDirForSession(sessionId: number): Promise<string> {
  const ids = await taskIdsForSession(sessionId);
  if (ids.length === 0) return supervisorRepoDir();
  return (await repoDirForTask(ids[0])).dir;
}

// Where per-session prompt files live (outside any worktree so the agent never
// commits them). The startup command can `cat` this to seed the session.
function promptDir(): string {
  const repo = process.env.PM_REPO_DIR ?? process.cwd();
  return join(repo, "data", "prompts");
}

// The command the session's PTY runs in the worktree is the shared worker
// startup template — see `sessionStartup` in dispatch.ts (PM_SESSION_CMD).

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

  // Resolve the repo this task's worktree is cut from: the task's cache clone (ensured
  // current), or the supervisor's own checkout for a repo-less task. The worktree is a
  // worktree OF that clone, branched off the repo's default branch — so start-local
  // works on any registered repo, not just the supervisor's own.
  const repo = await repoDirForTask(primary, { ensure: true });
  if (repo.error)
    return { ok: false, error: `repo cache unavailable: ${repo.error}`, output: repo.output };
  const repoCwd = repo.dir;
  const baseRef = repo.baseBranch ?? MAIN_BRANCH;

  // One worktree + branch for all selected tasks, named after the primary task.
  const branch = opts.branch ?? `pm/task-${primary}`;
  const worktreePath = worktreePathFor(primary);
  mkdirSync(worktreeBase(), { recursive: true });

  const add = opts.fetchRemote
    ? await worktreeAddRemote(worktreePath, branch, baseRef, repoCwd)
    : await worktreeAdd(worktreePath, branch, baseRef, repoCwd);
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

/** Tear down a session's workspace and archive the session row. The actual merge
 *  of its branch into main is a normal git action; reconciliation then reads the
 *  trailers off main. Refuses to destroy unfinished work: a dirty local worktree,
 *  or a dirty/unpushed exe VM clone (whose teardown deletes the only copy).
 *  Exhaustive over SessionKind, so a new kind forces a teardown decision here. */
export async function landSession(sessionId: number): Promise<LandResult> {
  const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
  if (!session) return { ok: false, error: `unknown session "${sessionId}"` };

  const teardown = await match(session.kind)
    .with(SessionKind.Local, async (): Promise<LandResult> => {
      // Tear down the live PTY (if any) before removing its worktree from under it.
      killSessionPty(sessionId);
      if (session.worktreePath) {
        const rm = await worktreeRemove(session.worktreePath, {
          cwd: await repoDirForSession(sessionId),
        });
        if (!rm.ok) {
          return {
            ok: false,
            error: "git worktree remove failed (commit or clean the worktree first)",
            output: rm.output,
          };
        }
      }
      return { ok: true, session };
    })
    // remote: the run lives in Claude's cloud — nothing on this side to tear down.
    .with(SessionKind.Remote, async (): Promise<LandResult> => ({ ok: true, session }))
    .with(SessionKind.Exe, async (): Promise<LandResult> => {
      const res = await teardownExeWorkspace(session, { force: false });
      return res.ok ? { ok: true, session } : res;
    })
    .exhaustive();
  if (!teardown.ok) return teardown;

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
 *    as stopped; the operator stops the actual run in the Claude web UI.
 *  - exe: kill the worker's tmux and delete its VM (discarding any in-progress
 *    work — the VM is the workspace). */
export async function stopSession(sessionId: number): Promise<StopResult> {
  const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
  if (!session) return { ok: false, error: `unknown session "${sessionId}"` };

  // Force-teardown per kind; failures are logged but never block the abort — the
  // point is to stop the agent, not to garbage collect perfectly. Exhaustive over
  // SessionKind, so a new kind forces a decision here.
  await match(session.kind)
    .with(SessionKind.Local, async () => {
      // Kill the live agent first, then drop its worktree out from under it.
      killSessionPty(sessionId);
      if (session.worktreePath) {
        const rm = await worktreeRemove(session.worktreePath, {
          force: true,
          cwd: await repoDirForSession(sessionId),
        });
        if (!rm.ok) console.warn(`stop: worktree remove (non-fatal): ${rm.output}`);
      }
    })
    // remote: we can't reach the cloud run from here — recording the stop (below)
    // is all this side can do; the operator stops the run in the Claude web UI.
    .with(SessionKind.Remote, async () => {})
    // exe: raze the VM, unfinished work and all — that's what abort means.
    .with(SessionKind.Exe, async () => {
      await teardownExeWorkspace(session, { force: true });
    })
    .exhaustive();

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
