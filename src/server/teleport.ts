import { createServer } from "node:net";
import { join } from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "./db.ts";
import { lsRemoteHeads } from "./git.ts";
import { type Session, sessions, tasks } from "./schema.ts";
import { startLocalSession, worktreePathFor } from "./worktree.ts";

// Teleport pulls a running CLOUD (`claude --remote`) session down onto the laptop
// as a LOCAL worktree session, continuing the SAME conversation via
// `claude --teleport <id>`. The operator did this by hand for t67; this automates
// that flow end to end: find the cloud session id + the branch the cloud worker
// pushed, cut a worktree on it, swap the remote session row for a local one, and
// bring the agent up in tmux so the existing web shell attaches.

const MAIN_BRANCH = process.env.PM_MAIN_BRANCH ?? "main";
// Where free-port scanning starts. The supervisor owns 4500; teleported workers'
// dev servers get their own port above this so they never collide with it or each
// other (see t106 — isolate the workspace by port, not by killing index.ts).
const PORT_SCAN_START = Number(process.env.PM_TELEPORT_PORT_BASE ?? 4600);

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

/** True if `port` can be bound right now on loopback. */
function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

/** First free port at or above `start`, scanning upward. */
export async function findFreePort(start = PORT_SCAN_START): Promise<number> {
  for (let p = start; p < start + 500; p++) {
    if (await portFree(p)) return p;
  }
  throw new Error(`no free port found from ${start}`);
}

export type TeleportResult =
  | { ok: true; session: Session; branch: string; teleportId: string; port: number }
  | { ok: false; error: string; output?: string };

/** Teleport a task's running cloud session into a local worktree session. */
export async function teleportTask(taskId: number): Promise<TeleportResult> {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task) return { ok: false, error: `unknown task "${taskId}"` };

  // The live remote session row holds the URL; fall back to the task's own
  // sessionUrl (set at dispatch) so teleport works even if the row was pruned.
  const [remote] = await db
    .select()
    .from(sessions)
    .where(
      and(eq(sessions.taskId, taskId), eq(sessions.kind, "remote"), isNull(sessions.archivedAt)),
    );
  const url = remote?.url ?? task.sessionUrl;
  if (!url) return { ok: false, error: "task has no remote session to teleport" };

  const teleportId = parseTeleportId(url);
  if (!teleportId) return { ok: false, error: `no teleport id in session URL "${url}"` };

  // Discover the branch the cloud worker pushed (descriptive pm/task-<id>-<slug>);
  // fall back to a fresh pm/task-<id> off main if nothing's been pushed yet.
  const heads = await lsRemoteHeads(`refs/heads/pm/task-${taskId}*`);
  const picked = pickWorkerBranch(heads, taskId);
  const branch = picked ?? `pm/task-${taskId}`;

  // Each teleported worker gets a free port + an isolated data dir under its own
  // worktree, so its `bun run dev` never fights the supervisor (4500 / data/pgdata)
  // or another teleport. The worktree is directory-isolated already; we name the
  // data dir explicitly so the worker inherits it rather than being told to set it.
  const port = await findFreePort();
  const worktreePath = worktreePathFor(taskId);
  const dataDir = join(worktreePath, "data", "pgdata");

  const started = await startLocalSession(taskId, {
    branch,
    fetchRemote: picked != null,
    startup: `claude --teleport ${teleportId}`,
    env: { PORT: String(port), PM_DATA_DIR: dataDir },
  });
  if (!started.ok) return started;

  // Swap the remote session for the new local one: archive the remote row and
  // clear the task's remote runtime state (the cloud run is now local).
  if (remote) {
    await db
      .update(sessions)
      .set({ state: "idle", archivedAt: new Date(), updatedAt: new Date() })
      .where(eq(sessions.id, remote.id));
  }
  await db
    .update(tasks)
    .set({ sessionState: null, updatedAt: new Date() })
    .where(eq(tasks.id, taskId));

  return { ok: true, session: started.session, branch, teleportId, port };
}
