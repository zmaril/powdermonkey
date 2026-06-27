import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "./db.ts";
import { pullMain } from "./git.ts";
import { type Phase, type Task, phases, tasks } from "./schema.ts";

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

/** Build the full worker prompt + per-phase trailer lines for a task. Shared by
 *  start-local and dispatch so a worker — local or remote — gets identical
 *  instructions and the same PM-Phase trailers to stamp finished phases with;
 *  reconciliation reads those trailers back once the branch lands on main. */
export function buildTaskPrompt(
  task: Task,
  taskPhases: Phase[],
): { prompt: string; trailers: string[] } {
  const phaseLines = taskPhases.map((p) => `- ${p.name}`).join("\n");
  // Per-phase trailer lines so each finished phase can stamp its commit.
  const trailers = taskPhases.map((p) => `PM-Phase: ${p.id}   # ${p.name}`);
  const prompt = [
    `Task: ${task.title}`,
    "",
    "Phases:",
    phaseLines,
    "",
    "Work against main and open a pull request when done.",
    "",
    "Follow the `powdermonkey` skill. As you finish each phase, add its trailer to",
    "the commit that completes it (progress is read off these once they land on main):",
    ...trailers,
  ].join("\n");
  return { prompt, trailers };
}

/** Fetch a task + its live (non-archived, ordered) phases and build the prompt
 *  and trailers. Returns null when the task doesn't exist. The single place that
 *  loads a task's phases for prompting — start-local, dispatch and the
 *  `GET /tasks/:id/prompt` route all go through here. */
export async function loadTaskPrompt(
  taskId: number,
): Promise<{ prompt: string; trailers: string[] } | null> {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task) return null;

  const taskPhases = await db
    .select()
    .from(phases)
    .where(and(eq(phases.taskId, taskId), isNull(phases.archivedAt)))
    .orderBy(asc(phases.position));

  return buildTaskPrompt(task, taskPhases);
}

/** Default argv. Override the leading args with PM_DISPATCH_CMD (space-split). */
function dispatchArgv(prompt: string): string[] {
  const base = (process.env.PM_DISPATCH_CMD ?? "claude --remote -p").split(/\s+/).filter(Boolean);
  return [...base, prompt];
}

/** Pull the first URL out of the command output. The session lives at that URL. */
export function parseSessionUrl(output: string): string | null {
  const m = output.match(/https?:\/\/\S+/);
  return m ? m[0] : null;
}

export type DispatchResult =
  | { ok: true; sessionUrl: string }
  | { ok: false; error: string; output?: string };

export async function dispatchTask(taskId: number): Promise<DispatchResult> {
  const built = await loadTaskPrompt(taskId);
  if (!built) return { ok: false, error: `unknown task "${taskId}"` };

  // Know the repo's current state before dispatching. A non-ff pull is logged
  // but not fatal — dispatch still execs against main in the cloud.
  const pull = await pullMain();
  if (!pull.ok) console.warn(`git pull (non-fatal): ${pull.output}`);

  const { prompt } = built;
  let output: string;

  if (process.env.PM_DISPATCH_DRY_RUN) {
    output = `https://claude.ai/code/dry-run-${taskId}`;
  } else {
    const proc = Bun.spawn(dispatchArgv(prompt), {
      cwd: process.env.PM_REPO_DIR ?? process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    output = (out + err).trim();
    if (code !== 0) return { ok: false, error: `dispatch exited ${code}`, output };
  }

  const sessionUrl = parseSessionUrl(output);
  if (!sessionUrl) return { ok: false, error: "no session URL in output", output };

  await db
    .update(tasks)
    .set({ sessionUrl, status: "dispatched", sessionState: "running", updatedAt: new Date() })
    .where(eq(tasks.id, taskId));

  return { ok: true, sessionUrl };
}
