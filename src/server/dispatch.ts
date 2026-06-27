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

/** Build the prompt the remote session runs: do the task, open a PR. */
export function taskPrompt(task: Task, taskPhases: Phase[]): string {
  const phaseLines = taskPhases.map((p) => `- ${p.name}`).join("\n");
  return [
    `Task: ${task.title}`,
    "",
    "Phases:",
    phaseLines,
    "",
    "Work against main and open a pull request when done.",
  ].join("\n");
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
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task) return { ok: false, error: `unknown task "${taskId}"` };

  const taskPhases = await db
    .select()
    .from(phases)
    .where(and(eq(phases.taskId, taskId), isNull(phases.archivedAt)))
    .orderBy(asc(phases.position));

  // Know the repo's current state before dispatching. A non-ff pull is logged
  // but not fatal — dispatch still execs against main in the cloud.
  const pull = await pullMain();
  if (!pull.ok) console.warn(`git pull (non-fatal): ${pull.output}`);

  const prompt = taskPrompt(task, taskPhases);
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
