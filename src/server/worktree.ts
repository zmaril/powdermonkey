import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "./db.ts";
import { taskPrompt } from "./dispatch.ts";
import { worktreeAdd, worktreeRemove } from "./git.ts";
import { type Session, phases, sessions, tasks } from "./schema.ts";

// A local session is the on-laptop mirror of `claude --remote`: an isolated git
// worktree on `pm/task-<id>`, branched off main, where work happens without
// touching the supervisor's main checkout. When the branch lands on main with
// PM-Phase trailers, reconciliation marks the work done — same as a cloud session.

const MAIN_BRANCH = process.env.PM_MAIN_BRANCH ?? "main";

function worktreeBase(): string {
  const repo = process.env.PM_REPO_DIR ?? process.cwd();
  return process.env.PM_WORKTREE_DIR ?? join(repo, "..", "pm-worktrees");
}

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

export async function startLocalSession(taskId: number): Promise<StartLocalResult> {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task) return { ok: false, error: `unknown task "${taskId}"` };

  const taskPhases = await db
    .select()
    .from(phases)
    .where(and(eq(phases.taskId, taskId), isNull(phases.archivedAt)))
    .orderBy(asc(phases.position));

  const branch = `pm/task-${taskId}`;
  const worktreePath = join(worktreeBase(), `task-${taskId}`);
  mkdirSync(worktreeBase(), { recursive: true });

  const add = await worktreeAdd(worktreePath, branch, MAIN_BRANCH);
  if (!add.ok) return { ok: false, error: "git worktree add failed", output: add.output };

  const [session] = await db
    .insert(sessions)
    .values({ kind: "local", state: "running", taskId, branch, worktreePath })
    .returning();
  await db
    .update(tasks)
    .set({ status: "dispatched", updatedAt: new Date() })
    .where(eq(tasks.id, taskId));

  // Hand over the per-phase trailer lines so each finished phase can stamp its
  // commit; reconciliation reads these back once the branch lands on main.
  const trailers = taskPhases.map((p) => `PM-Phase: ${p.id}   # ${p.name}`);
  const prompt = [
    taskPrompt(task, taskPhases),
    "",
    "Follow the `powdermonkey` skill. As you finish each phase, add its trailer to",
    "the commit that completes it (progress is read off these once they land on main):",
    ...trailers,
  ].join("\n");

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
    .set({ state: "idle", archivedAt: new Date(), updatedAt: new Date() })
    .where(eq(sessions.id, sessionId))
    .returning();
  return { ok: true, session: updated };
}
