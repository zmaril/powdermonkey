import { join } from "node:path";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import { SessionKind, SessionState, TaskStatus } from "../shared/types.ts";
import { db } from "./db.ts";
import { CROSS_REPO_ERROR, loadTaskPrompt, spansRepos } from "./dispatch.ts";
import { teardownRemoteWorker } from "./exe-dev.ts";
import { worktreeRemove } from "./git.ts";
import { cancelLocalWorker, provisionLocalWorker, teardownLocalWorker } from "./local-disponent.ts";
import { repoDirForTask, supervisorRepoDir } from "./repo-cache.ts";
import { type Session, sessions, tasks } from "./schema.ts";
import { killSessionPty } from "./session-pty.ts";
import { linkSessionTasks, taskIdsForSession } from "./session-tasks.ts";

// A local session is the on-laptop mirror of `claude --remote`: an isolated git
// worktree on `pm/task-<id>`, branched off main, where work happens without
// touching the supervisor's main checkout. When the branch lands on main with
// PM-Phase trailers, reconciliation marks the work done — same as a cloud session.
//
// Every local start — plain start-local AND teleport — runs through disponent's
// local tmux backend (local-disponent.ts): the engine cuts the worktree with
// `isolation: "worktree"` off pm's repo cache clone, drops the brief in, and runs
// the agent in its own `tmux -L disponent` session. Land reaps it (worktree gone,
// branch kept); stop cancels it (agent gone, worktree kept). Teleport rides the same
// backend: its remote-branch fetch maps onto disponent's per-dispatch `fetchRemote`,
// and its `claude --teleport <id>` startup onto `agentCmd`. (Stage 3 retired the old
// pm-owned git-worktree + PTY provisioning path; disponent owns local dispatch now.)

/** The repo dir that owns a session's worktree — the cache clone of its (first) task's
 *  repo, or the supervisor's own checkout when the task is repo-less. `land`/`stop`
 *  run `git worktree remove` from here for a REMOTE session's (absent) worktree or a
 *  pre-Stage-3 pm-owned local row; a disponent-local session's worktree is the
 *  engine's to remove. Path-only (no clone/fetch) — the clone already exists. */
async function repoDirForSession(sessionId: number): Promise<string> {
  const ids = await taskIdsForSession(sessionId);
  if (ids.length === 0) return supervisorRepoDir();
  return (await repoDirForTask(ids[0])).dir;
}

/** Overrides for a local session. Plain `start-local` passes none and gets a fresh
 *  `pm/task-<id>` branch off the clone's HEAD running the task prompt. Teleport passes
 *  a discovered cloud branch (fetched from the remote) and a `claude --teleport`
 *  startup. */
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

  // One worktree + branch for all selected tasks, named after the primary task.
  const branch = opts.branch ?? `pm/task-${primary}`;
  const ctx: LaunchCtx = { ids, primary, branch, repoCwd, prompt, trailers };

  // Every local start rides disponent's local backend (Stage 3): plain start-local
  // cuts a fresh `pm/task-<id>` worktree off the clone's HEAD; teleport's remote-branch
  // fetch + `claude --teleport <id>` startup map onto disponent's `fetchRemote` +
  // `agentCmd`. See the module comment.
  return startLocalViaDisponent(ctx, opts);
}

/** The resolved launch inputs both provisioning paths share. */
type LaunchCtx = {
  ids: number[];
  primary: number;
  branch: string;
  repoCwd: string;
  prompt: string;
  trailers: string[];
};

/** Insert the session row, link its tasks, and mark them all `Dispatched` — the
 *  identical bookkeeping tail both provisioning paths run once their worker is up.
 *  The only per-path difference is the insert `values` (disponent adds `vmName`). */
async function recordDispatchedSession(
  values: typeof sessions.$inferInsert,
  ids: number[],
): Promise<Session> {
  const [session] = await db.insert(sessions).values(values).returning();
  await linkSessionTasks(session.id, ids);
  await db
    .update(tasks)
    .set({ status: TaskStatus.Dispatched, updatedAt: new Date() })
    .where(inArray(tasks.id, ids));
  return session;
}

/** Provision through disponent's local tmux backend: the engine cuts the worktree
 *  (isolation "worktree", branch `pm/task-<id>` off the cache clone) and runs the
 *  agent in tmux. pm keeps a tracking row — branch + worktree_path + the engine
 *  session uid in vm_name (so land/stop reap/cancel it). No pm-owned git or PTY.
 *  Teleport rides the same path: `opts.fetchRemote` cuts the worktree off the clone's
 *  origin branch, and `opts.startup` (`claude --teleport <id>`) runs as the agent
 *  command verbatim. Both are absent for a plain start-local. */
async function startLocalViaDisponent(
  ctx: LaunchCtx,
  opts: StartLocalOpts,
): Promise<StartLocalResult> {
  const { ids, primary, branch, repoCwd, prompt, trailers } = ctx;

  const prov = await provisionLocalWorker({
    taskId: primary,
    repoDir: repoCwd,
    branch,
    brief: prompt,
    fetchRemote: opts.fetchRemote,
    startup: opts.startup,
  });
  if (!prov.ok) return { ok: false, error: prov.error, output: prov.output };

  // disponent's local layout puts the worktree at `<workDir>/task`; store that as
  // the session's worktree_path (what the UI's shell fallback opens), and the
  // engine session uid in vm_name so land (reap) / stop (cancel) reach the engine.
  const worktreePath = join(prov.workDir, "task"); // lint-allow-string: path segment, not TaskKind
  const session = await recordDispatchedSession(
    {
      kind: SessionKind.Local,
      state: SessionState.Running,
      branch,
      worktreePath,
      vmName: prov.uid,
    },
    ids,
  );

  // TERMINAL-ATTACH: the agent runs under `tmux -L ${prov.handle.socket} attach -t
  // ${prov.handle.tmux}` (disponent's own tmux, not pm's). We do NOT spawn a
  // pm-session-<id> here — instead /pty (app.ts) resolves this session's attach
  // target from disponent's typed Session fields (resolveLocalAttachTarget) and
  // attaches the browser terminal straight to that tmux, so the operator sees the
  // real agent rather than a fresh shell.

  return { ok: true, session, worktreePath, branch, prompt, trailers };
}

/** A local session — always provisioned through disponent since Stage 3, so its
 *  engine session uid is parked in vm_name (a plain remote session has none). Kept as
 *  a predicate because `land`/`stop` also see REMOTE sessions and any pre-Stage-3
 *  pm-owned local rows, which take the non-engine teardown branch. */
export function isDisponentLocal(session: Session): boolean {
  return session.kind === SessionKind.Local && session.vmName != null;
}

/** Load a session by id, or the "unknown session" error that land, stop, and the
 *  editor opener all return when it's gone. */
export async function requireSession(
  sessionId: number,
): Promise<{ ok: true; session: Session } | { ok: false; error: string }> {
  const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
  if (!session) return { ok: false, error: `unknown session "${sessionId}"` };
  return { ok: true, session };
}

/** Flip a session into a terminal state and archive it (land → idle, stop →
 *  stopped), returning the updated row — the shared closing move of both paths. */
async function archiveSession(sessionId: number, state: SessionState): Promise<Session> {
  const [updated] = await db
    .update(sessions)
    .set({ state, archivedAt: new Date(), updatedAt: new Date() })
    .where(eq(sessions.id, sessionId))
    .returning();
  return updated;
}

export type LandResult =
  | { ok: true; session: Session }
  | { ok: false; error: string; output?: string };

/** Tear down a local session's worktree and archive the session row. The actual
 *  merge of its branch into main is a normal git action; reconciliation then reads
 *  the trailers off main. Fails if the worktree has uncommitted changes. */
export async function landSession(sessionId: number): Promise<LandResult> {
  const found = await requireSession(sessionId);
  if (!found.ok) return found;
  const { session } = found;

  if (isDisponentLocal(session)) {
    // The engine owns teardown: reap kills the tmux agent and removes the
    // worktree (keeping the branch's committed work). No pm PTY / git here.
    const r = await teardownLocalWorker(session.vmName as string);
    if (!r.ok) return { ok: false, error: "disponent reap failed", output: r.output };
  } else {
    // Remote (exe.dev / claude --remote), or a pre-Stage-3 pm-owned local row that
    // predates the disponent flip. Tear down the live PTY (if any — a no-op for
    // remote) before removing any pm-owned worktree out from under it.
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

    // Remote exe.dev worker (no worktree): delete its VM. No-op for claude --remote.
    await teardownRemoteWorker(session);
  }

  const updated = await archiveSession(sessionId, SessionState.Idle);
  return { ok: true, session: updated };
}

export type StopResult =
  | { ok: true; session: Session }
  | { ok: false; error: string; output?: string };

/** Abort a session that's still running. Unlike `land` (graceful teardown
 *  of *finished* work, which refuses a dirty worktree), `stop` is the kill switch: it
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
  const found = await requireSession(sessionId);
  if (!found.ok) return found;
  const { session } = found;

  if (isDisponentLocal(session)) {
    // Abort through the engine: cancel kills the tmux agent and LEAVES the
    // worktree in place for inspection (reap, on land, is what removes it). A
    // failed cancel is logged, never fatal — the point is to stop the agent.
    const r = await cancelLocalWorker(session.vmName as string);
    if (!r.ok) console.warn(`stop: disponent cancel (non-fatal): ${r.output}`);
  } else if (session.kind === SessionKind.Local) {
    // A pre-Stage-3 pm-owned local row (no engine uid): kill the live agent first,
    // then force-drop its worktree. The force-remove can still fail (e.g. the path is
    // already gone); that's logged but never blocks the abort — the point is to stop
    // the agent, not to garbage collect perfectly.
    killSessionPty(sessionId);
    if (session.worktreePath) {
      const rm = await worktreeRemove(session.worktreePath, {
        force: true,
        cwd: await repoDirForSession(sessionId),
      });
      if (!rm.ok) console.warn(`stop: worktree remove (non-fatal): ${rm.output}`);
    }
  }

  // Remote exe.dev worker: delete its VM (best-effort). No-op for local / claude --remote.
  await teardownRemoteWorker(session);

  const updated = await archiveSession(sessionId, SessionState.Stopped);

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
