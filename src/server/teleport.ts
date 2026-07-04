import { and, eq, inArray, isNull } from "drizzle-orm";
import { SessionKind, SessionState } from "../shared/types.ts";
import { db } from "./db.ts";
import { lsRemoteHeads } from "./git.ts";
import { type Session, sessions, sessionTasks, tasks } from "./schema.ts";
import { taskIdsForSession } from "./session-tasks.ts";
import { startLocalSession } from "./worktree.ts";

// Teleport pulls a running CLOUD (`claude --remote`) session down onto the laptop
// as a LOCAL worktree session, continuing the SAME conversation via
// `claude --teleport <id>`. The operator did this by hand for t67; this automates
// that flow end to end: find the cloud session id + the branch the cloud worker
// pushed, cut a worktree on it, swap the remote session row for a local one, and
// bring the agent up in tmux so the existing web shell attaches.
//
// Port isolation is NOT handled here: a teleported worker that boots its own dev
// server is responsible for binding a free port without crashing (the supervisor
// already does — see index.ts), and the worktree's data dir is directory-isolated
// by default. Keeping that out of the orchestrator is what lets PowderMonkey drive
// projects other than itself.

/** Pull the cloud teleport id (`session_…`) out of a remote session URL. The URL
 *  is whatever `claude --remote` printed (e.g. https://claude.ai/code/session_abc);
 *  the id is the last path segment that looks like a session handle. */
export function parseTeleportId(url: string): string | null {
  const m = url.match(/session_[A-Za-z0-9-]+/);
  return m ? m[0] : null;
}

/** Choose the branch the cloud worker pushed for this task. Branches are
 *  descriptive `pm/task-<id>-<slug>`, so prefer one carrying a slug; accept a bare
 *  `pm/task-<id>`; ignore look-alikes like `pm/task-<id>0-…` from the glob. Returns
 *  null when nothing matching was pushed yet (caller falls back to main). */
export function pickWorkerBranch(heads: string[], taskId: number): string | null {
  const re = new RegExp(`^pm/task-${taskId}(?:-.*)?$`);
  const matches = heads.filter((h) => re.test(h));
  const withSlug = matches.find((h) => h !== `pm/task-${taskId}`);
  return withSlug ?? matches[0] ?? null;
}

export type TeleportResult =
  | { ok: true; session: Session; branch: string; teleportId: string }
  | { ok: false; error: string; output?: string };

/** Teleport a task's running cloud session into a local worktree session. */
export async function teleportTask(taskId: number): Promise<TeleportResult> {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task) return { ok: false, error: `unknown task "${taskId}"` };

  // The live remote session row holds the URL; fall back to the task's own
  // sessionUrl (set at dispatch) so teleport works even if the row was pruned.
  // The session is reached through the session_tasks join now, not a column.
  const [match] = await db
    .select()
    .from(sessions)
    .innerJoin(sessionTasks, eq(sessionTasks.sessionId, sessions.id))
    .where(
      and(
        eq(sessionTasks.taskId, taskId),
        eq(sessions.kind, SessionKind.Remote),
        isNull(sessions.archivedAt),
      ),
    );
  const remote = match?.sessions;
  const url = remote?.url ?? task.sessionUrl;
  if (!url) return { ok: false, error: "task has no remote session to teleport" };

  const teleportId = parseTeleportId(url);
  if (!teleportId) return { ok: false, error: `no teleport id in session URL "${url}"` };

  // Discover the branch the cloud worker pushed (descriptive pm/task-<id>-<slug>);
  // fall back to a fresh pm/task-<id> off main if nothing's been pushed yet.
  const heads = await lsRemoteHeads(`refs/heads/pm/task-${taskId}*`);
  const picked = pickWorkerBranch(heads, taskId);
  const branch = picked ?? `pm/task-${taskId}`;

  // Pull the whole batch down: a cloud session may have been dispatched for several
  // tasks, so the new local session works the same set. The teleported task leads
  // (it names the branch/worktree); any siblings follow.
  const linked = remote ? await taskIdsForSession(remote.id) : [taskId];
  const startIds = [taskId, ...linked.filter((id) => id !== taskId)];

  const started = await startLocalSession(startIds, {
    branch,
    fetchRemote: picked != null,
    startup: `claude --teleport ${teleportId}`,
  });
  if (!started.ok) return started;

  // Swap the remote session for the new local one: archive the remote row and
  // clear the batch's remote runtime state (the cloud run is now local). The
  // archived remote's links stay put (harmless — liveness keys on the session row);
  // the new local session carries its own links from startLocalSession.
  if (remote) {
    await db
      .update(sessions)
      .set({ state: SessionState.Idle, archivedAt: new Date(), updatedAt: new Date() })
      .where(eq(sessions.id, remote.id));
  }
  await db
    .update(tasks)
    .set({ sessionState: null, updatedAt: new Date() })
    .where(inArray(tasks.id, startIds));

  return { ok: true, session: started.session, branch, teleportId };
}
