// Chat backend: streams a conversational `claude -p` (Max seat, no API key) as
// NDJSON, per thread. A thread can be a plain assistant chat, or a SUPERVISOR
// chat bound to a goal/workspace — in which case the system prompt is primed with
// that goal's intent, repo, and current tasks. Each thread resumes its own
// claude session via `--resume`.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Effect, Stream } from "effect";
import {
  bindThread,
  ensureThread,
  getGoalContext,
  getThread,
  getWorkspaceContext,
  setThreadSession,
  type ThreadBind,
} from "./chat-repo.ts";
import { ROOT } from "./db.ts";
import { getGoal, getScratchpad, getTask, workspaceForTask } from "./repo.ts";

const CHAT_CWD = join(ROOT, "data", "chat");
mkdirSync(CHAT_CWD, { recursive: true });

const PLAN_HINT = `When the operator wants to start concrete work, END your reply with a fenced block exactly like:

\`\`\`propose_plan
{"goalTitle": "<short goal title>", "intent": "<one or two sentences of intent>"}
\`\`\`

Only emit that block when proposing concrete work. Keep prose short. Do not edit files.`;

const MILESTONE_HINT = `When the operator wants to break this goal into an ordered sequence of milestones,
END your reply with a fenced block exactly like:

\`\`\`propose_milestones
[{"title": "First milestone", "detail": "what done means"}, {"title": "Second milestone"}]
\`\`\`

List them in the order they should be done. Only emit it when proposing a concrete breakdown.`;

const SCRATCHPAD_HINT = `To propose a change to the operator's scratchpad, END your reply with a fenced block exactly like:

\`\`\`propose_scratchpad
{"mode": "append", "content": "the note to add"}
\`\`\`

Use "append" to add a note, or "replace" with the full new content to reorganize. Only when proposing a concrete change.`;

const ASSISTANT_SYSTEM = `You are the PowderMonkey chat assistant — a concise, friendly co-pilot for a single
operator running many \`claude -p\` workers against local repos.

${PLAN_HINT}`;

async function buildSystem(thread: Awaited<ReturnType<typeof getThread>>): Promise<string> {
  const pad = await Effect.runPromise(getScratchpad());
  const padSection = `

The operator's shared SCRATCHPAD (loose notes — reference them, and you may propose edits):
"""
${pad || "(empty)"}
"""

${SCRATCHPAD_HINT}`;
  if (thread?.kind === "supervisor" && thread.goalId) {
    const ctx = await getGoalContext(thread.goalId);
    if (ctx) {
      const taskLines = ctx.tasks.length
        ? ctx.tasks.map((t) => `- ${t.title} [${t.status}]`).join("\n")
        : "(none yet)";
      return (
        `You are the PowderMonkey SUPERVISOR for the goal "${ctx.goal.title}"${
          ctx.workspace ? ` in workspace "${ctx.workspace.name}"` : ""
        }.
${ctx.goal.intent ? `Intent: ${ctx.goal.intent}` : ""}
${ctx.workspace?.repoPath ? `Repo: ${ctx.workspace.repoPath}` : ""}

Current tasks for this goal:
${taskLines}

Discuss this goal with the operator: refine scope, sequence the work, surface risks and unknowns.

${MILESTONE_HINT}

${PLAN_HINT}` + padSection
      );
    }
  }
  if (thread?.kind === "supervisor" && thread.workspaceId) {
    const ctx = await getWorkspaceContext(thread.workspaceId);
    if (ctx) {
      const goalLines = ctx.goals.length
        ? ctx.goals.map((g) => `- ${g.title} [${g.status}]`).join("\n")
        : "(none yet)";
      return (
        `You are the PowderMonkey SUPERVISOR for workspace "${ctx.workspace.name}"${
          ctx.workspace.repoPath ? ` (repo: ${ctx.workspace.repoPath})` : ""
        }.

Goals in this workspace:
${goalLines}

Help the operator decide what to work on and how to scope goals. ${PLAN_HINT}` + padSection
      );
    }
  }
  return ASSISTANT_SYSTEM;
}

// What the operator currently has open in the middle work pane. Drives the
// new-thread default workspace and the @this context injection.
export interface Screen {
  kind: "none" | "scratchpad" | "workspace" | "goal" | "task";
  id?: string;
}

export interface ChatRequest {
  threadId: string;
  text: string;
  bind?: ThreadBind;
  screen?: Screen;
}

// The workspace a screen belongs to (workspace itself, a goal's, or a task's).
async function screenWorkspaceId(screen?: Screen): Promise<string | null> {
  if (!screen?.id) return null;
  if (screen.kind === "workspace") return screen.id;
  if (screen.kind === "goal") {
    const g = await Effect.runPromise(getGoal(screen.id));
    return g?.workspaceId ?? null;
  }
  if (screen.kind === "task") {
    const w = await Effect.runPromise(workspaceForTask(screen.id));
    return w?.id ?? null;
  }
  return null;
}

// A human-readable dump of what's on screen — injected when the operator writes
// @this so the supervisor sees exactly what they're looking at.
async function resolveScreenContext(screen?: Screen): Promise<string> {
  if (!screen) return "";
  if (screen.kind === "scratchpad") {
    const pad = await Effect.runPromise(getScratchpad());
    return `The operator's SCRATCHPAD:\n"""\n${pad || "(empty)"}\n"""`;
  }
  if (screen.kind === "workspace" && screen.id) {
    const c = await getWorkspaceContext(screen.id);
    if (!c) return "";
    const goals = c.goals.length
      ? c.goals.map((g) => `- ${g.title} [${g.status}]`).join("\n")
      : "(none)";
    return `WORKSPACE "${c.workspace.name}"${c.workspace.repoPath ? ` (repo: ${c.workspace.repoPath})` : ""}\nGoals:\n${goals}`;
  }
  if (screen.kind === "goal" && screen.id) {
    const c = await getGoalContext(screen.id);
    if (!c) return "";
    const tasks = c.tasks.length
      ? c.tasks.map((t) => `- ${t.title} [${t.status}]`).join("\n")
      : "(none)";
    return `GOAL "${c.goal.title}"${c.goal.intent ? `\nIntent: ${c.goal.intent}` : ""}${c.workspace ? `\nWorkspace: ${c.workspace.name}` : ""}\nTasks:\n${tasks}`;
  }
  if (screen.kind === "task" && screen.id) {
    const t = await Effect.runPromise(getTask(screen.id));
    if (!t) return "";
    return [
      `TASK "${t.title}" [${t.status}]`,
      t.objective ? `Objective: ${t.objective}` : "",
      t.lastProgress ? `Last progress: ${t.lastProgress}` : "",
      t.question ? `Open question: ${t.question}` : "",
      t.branch ? `Branch: ${t.branch}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

// If the message says @this, append the on-screen context for this turn.
async function expandThis(text: string, screen?: Screen): Promise<string> {
  if (!/@this\b/.test(text)) return text;
  const ctx = await resolveScreenContext(screen);
  if (!ctx) return text;
  return `${text}\n\n--- @this refers to what's on the operator's screen right now ---\n${ctx}`;
}

// On the first message of a fresh, unbound thread, default its workspace to
// whatever's on screen. The operator can change it via the switcher — this is a
// default, not a lock.
async function applyScreenDefault(threadId: string, bind: ThreadBind | undefined, screen?: Screen) {
  if (bind?.kind === "supervisor" && (bind.goalId || bind.workspaceId)) return; // explicit bind wins
  const cur = await getThread(threadId);
  if (!cur || cur.kind !== "assistant" || cur.workspaceId) return;
  const wsId = await screenWorkspaceId(screen);
  if (!wsId) return;
  const ctx = await getWorkspaceContext(wsId);
  await bindThread(threadId, {
    kind: "supervisor",
    workspaceId: wsId,
    title: ctx ? `Supervisor · ${ctx.workspace.name}` : "Supervisor",
  });
}

// The events we stream to the client (mirrors the frontend StreamEvent union).
type ClientEvent =
  | { t: "text"; v: string }
  | { t: "tool"; id: string; name: string }
  | { t: "tool_done"; id: string }
  | { t: "session"; id: string }
  | { t: "error"; v: string }
  | { t: "done" };

// Pure: turn one claude NDJSON line into zero or more client events.
function parseLine(line: string): ClientEvent[] {
  let ev: any;
  try {
    ev = JSON.parse(line);
  } catch {
    return [];
  }
  if (ev.type === "stream_event") {
    const e = ev.event;
    if (e?.type === "content_block_delta" && e.delta?.type === "text_delta") {
      return [{ t: "text", v: e.delta.text }];
    }
    if (e?.type === "content_block_start" && e.content_block?.type === "tool_use") {
      return [{ t: "tool", id: e.content_block.id, name: e.content_block.name }];
    }
    return [];
  }
  if (ev.type === "user") {
    const parts = ev.message?.content;
    if (!Array.isArray(parts)) return [];
    return parts
      .filter((p: any) => p?.type === "tool_result")
      .map((p: any) => ({ t: "tool_done", id: p.tool_use_id }) as ClientEvent);
  }
  if (ev.type === "result") {
    const out: ClientEvent[] = [];
    if (ev.session_id) out.push({ t: "session", id: ev.session_id });
    if (ev.is_error) out.push({ t: "error", v: ev.result ?? "claude error" });
    return out;
  }
  return [];
}

const enc = new TextEncoder();
const frame = (e: ClientEvent): Uint8Array => enc.encode(`${JSON.stringify(e)}\n`);

// Build the claude process as a scoped resource: killed on stream completion,
// interruption, or client disconnect (acquireRelease ties it to the Scope).
function spawnClaude(prompt: string, system: string, resume: string, signal?: AbortSignal) {
  return Effect.acquireRelease(
    Effect.sync(() => {
      const cmd =
        `cd ${JSON.stringify(CHAT_CWD)} && exec claude -p "$PM_PROMPT" ` +
        `--append-system-prompt "$PM_SYSTEM" ${resume}` +
        `--output-format stream-json --include-partial-messages --verbose ` +
        `--dangerously-skip-permissions < /dev/null`;
      const proc = Bun.spawn(["bash", "-lc", cmd], {
        env: { ...process.env, PM_PROMPT: prompt, PM_SYSTEM: system },
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      });
      signal?.addEventListener("abort", () => proc.kill(), { once: true });
      return proc;
    }),
    (proc) => Effect.sync(() => proc.kill()),
  );
}

// Apply a supervisor binding on the first message of a fresh thread.
function applyBind(threadId: string, bind: ThreadBind | undefined) {
  return Effect.promise(async () => {
    if (!(bind?.kind === "supervisor" && (bind.goalId || bind.workspaceId))) return;
    const cur = await getThread(threadId);
    if (!cur || cur.kind !== "assistant") return;
    let title = "Supervisor";
    if (bind.goalId) {
      const ctx = await getGoalContext(bind.goalId);
      if (ctx) title = `Supervisor · ${ctx.goal.title}`;
    } else if (bind.workspaceId) {
      const ctx = await getWorkspaceContext(bind.workspaceId);
      if (ctx) title = `Supervisor · ${ctx.workspace.name}`;
    }
    await bindThread(threadId, { ...bind, title });
  });
}

export function streamChat(
  { threadId, text, bind, screen }: ChatRequest,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  // Prelude (ensure thread, bind, load context) then the live event stream,
  // all as one Effect.Stream; unwrapScoped runs the setup and scopes the process.
  const stream = Stream.unwrapScoped(
    Effect.gen(function* () {
      yield* Effect.promise(() => ensureThread(threadId));
      yield* applyBind(threadId, bind);
      yield* Effect.promise(() => applyScreenDefault(threadId, bind, screen));
      const thread = yield* Effect.promise(() => getThread(threadId));
      const system = yield* Effect.promise(() => buildSystem(thread));
      const prompt = yield* Effect.promise(() => expandThis(text, screen));
      const resume = thread?.claudeSessionId
        ? `--resume ${JSON.stringify(thread.claudeSessionId)} `
        : "";
      const proc = yield* spawnClaude(prompt, system, resume, signal);

      return Stream.fromReadableStream(
        () => proc.stdout as ReadableStream<Uint8Array>,
        (e) => new Error(String(e)),
      ).pipe(
        Stream.decodeText(),
        Stream.splitLines,
        // Parse each line; persist the claude session id when it appears.
        Stream.mapEffect((line) =>
          Effect.gen(function* () {
            const events = parseLine(line);
            for (const e of events) {
              if (e.t === "session") {
                yield* Effect.promise(() => setThreadSession(threadId, e.id));
              }
            }
            return events;
          }),
        ),
        Stream.flattenIterables,
      );
    }),
  ).pipe(
    Stream.map(frame),
    // Any failure becomes a single error frame instead of tearing the response.
    Stream.catchAll((err) => Stream.make(frame({ t: "error", v: String(err) }))),
    // Always close with a done sentinel.
    Stream.concat(Stream.make(frame({ t: "done" }))),
  );

  return Stream.toReadableStream(stream);
}
