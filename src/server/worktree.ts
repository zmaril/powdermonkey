import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import { SessionKind, SessionState, TaskStatus } from "../shared/types.ts";
import { db } from "./db.ts";
import { CROSS_REPO_ERROR, loadTaskPrompt, spansRepos } from "./dispatch.ts";
import { teardownRemoteWorker } from "./exe-dev.ts";
import { worktreeAdd, worktreeAddRemote, worktreeRemove } from "./git.ts";
import { cancelLocalWorker, provisionLocalWorker, teardownLocalWorker } from "./local-disponent.ts";
import { repoDirForTask, supervisorRepoDir } from "./repo-cache.ts";
import { type Session, sessions, tasks } from "./schema.ts";
import { killSessionPty, startSessionPty } from "./session-pty.ts";
import { linkSessionTasks, taskIdsForSession } from "./session-tasks.ts";

// A local session is the on-laptop mirror of `claude --remote`: an isolated git
// worktree on `pm/task-<id>`, branched off main, where work happens without
// touching the supervisor's main checkout. When the branch lands on main with
// PM-Phase trailers, reconciliation marks the work done — same as a cloud session.
//
// Provisioning has two selectable paths (slice 2 of issue 152). The DEFAULT stays pm's
// own git worktree + interactive tmux PTY (startLocalViaWorktree). Opting in with
// PM_LOCAL_BACKEND=disponent routes the default start through disponent's local
// tmux backend instead (local-disponent.ts): the engine cuts the worktree with
// `isolation: "worktree"` off pm's repo cache clone, drops the brief in, and runs
// the agent in its own `tmux -L disponent` session. Land reaps it (worktree gone,
// branch kept); stop cancels it (agent gone, worktree kept). TELEPORT always keeps
// the pm-owned path: disponent's local backend can't fetch a remote branch or run
// `claude --teleport`. (A later slice flips the default + retires the pm path once
// teleport is migrated.)

/** Which backend a plain `start-local` uses: the pm-owned git worktree + PTY
 *  (default), or disponent's local tmux worktree backend (PM_LOCAL_BACKEND=disponent).
 *  Teleport ignores this — it always needs the pm-owned path. */
function localDisponentEnabled(): boolean {
  return process.env.PM_LOCAL_BACKEND === "disponent";
}

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
  const ctx: LaunchCtx = { ids, primary, branch, repoCwd, prompt, trailers };

  // Teleport (a custom startup, and possibly a remote branch to fetch) always uses
  // pm's own worktree + PTY. A plain start-local uses disponent's local backend
  // when opted in (PM_LOCAL_BACKEND=disponent), else the pm-owned path — see the
  // module comment.
  const viaDisponent = !opts.fetchRemote && !opts.startup && localDisponentEnabled();
  return viaDisponent ? startLocalViaDisponent(ctx) : startLocalViaWorktree(ctx, baseRef, opts);
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
 *  session uid in vm_name (so land/stop reap/cancel it). No pm-owned git or PTY. */
async function startLocalViaDisponent(ctx: LaunchCtx): Promise<StartLocalResult> {
  const { ids, primary, branch, repoCwd, prompt, trailers } = ctx;

  const prov = await provisionLocalWorker({
    taskId: primary,
    repoDir: repoCwd,
    branch,
    brief: prompt,
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

  // TERMINAL-ATTACH SEAM (deferred — see PR/report): the agent runs under
  // `tmux -L ${prov.handle.socket} attach -t ${prov.handle.tmux}`. Pointing pm's
  // browser terminal at THAT tmux (rather than spawning its own via
  // startSessionPty) is not yet wired; until then /pty falls back to a fresh shell
  // in `worktreePath`. Provisioning + lifecycle are the solid, tested surface here.

  return { ok: true, session, worktreePath, branch, prompt, trailers };
}

/** Provision with pm's own git worktree + interactive tmux PTY. The teleport path:
 *  it may fetch a remote branch (fetchRemote) and runs a bespoke startup command
 *  (`claude --teleport <id>`), neither of which disponent's local backend supports. */
async function startLocalViaWorktree(
  ctx: LaunchCtx,
  baseRef: string,
  opts: StartLocalOpts,
): Promise<StartLocalResult> {
  const { ids, primary, branch, repoCwd, prompt, trailers } = ctx;

  const worktreePath = worktreePathFor(primary);
  mkdirSync(worktreeBase(), { recursive: true });

  const add = opts.fetchRemote
    ? await worktreeAddRemote(worktreePath, branch, baseRef, repoCwd)
    : await worktreeAdd(worktreePath, branch, baseRef, repoCwd);
  if (!add.ok) return { ok: false, error: "git worktree add failed", output: add.output };

  // One session row for all the tasks, linked through the session_tasks join; each
  // task is marked dispatched so the whole batch moves to Active together.
  const session = await recordDispatchedSession(
    { kind: SessionKind.Local, state: SessionState.Running, branch, worktreePath },
    ids,
  );

  // Stash the prompt where the startup command can reach it, then bring up the
  // session's persistent interactive PTY in the worktree. Clients attach to this
  // via /pty?session=<id>; it outlives any single browser connection.
  mkdirSync(promptDir(), { recursive: true });
  const promptPath = join(promptDir(), `session-${session.id}.md`);
  writeFileSync(promptPath, `${prompt}\n`);
  startSessionPty(session.id, worktreePath, sessionStartup(promptPath, opts.startup));

  return { ok: true, session, worktreePath, branch, prompt, trailers };
}

/** A local session provisioned through disponent (as opposed to pm's own worktree,
 *  the teleport path). Distinguished by the engine session uid parked in vm_name. */
function isDisponentLocal(session: Session): boolean {
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
    // pm-owned local (teleport) or remote. Tear down the live PTY (if any) before
    // removing its worktree out from under it.
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
    // Kill the live agent first, then drop its worktree out from under it. The
    // force-remove can still fail (e.g. the path is already gone); that's logged
    // but never blocks the abort — the point is to stop the agent, not to garbage
    // collect perfectly.
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
