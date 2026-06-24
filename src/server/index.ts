// PowderMonkey server: one Bun + Elysia process serving the REST API, the
// WebSocket live feed, and the built Mantine SPA. The live entity tables in
// PGlite (embedded Postgres) are the source of truth; every mutation also
// appends an action with its diff. The board is read straight from the tables.

import { existsSync } from "node:fs";
import { Effect } from "effect";
import { Elysia, t } from "elysia";
import type { TaskKind } from "../shared/types.ts";
import { streamChat } from "./chat.ts";
import {
  appendMessage,
  archiveThread,
  ensureThread,
  getMessages,
  getThread,
  listThreads,
  renameThread,
  setArchived,
  setWorkspace,
} from "./chat-repo.ts";
import { PORT } from "./config.ts";
import { initDb, ROOT } from "./db.ts";
import {
  approvePlan,
  launchTask,
  maybeResume,
  rejectPlan,
  resumePending,
  runningSessions,
  taskDiff,
} from "./dispatcher.ts";
import {
  actionsForEntity as actionsForEntity_fx,
  approveMilestone as approveMilestone_fx,
  archivedEntities as archivedEntities_fx,
  archiveGoal as archiveGoal_fx,
  archiveMilestone as archiveMilestone_fx,
  archiveTask as archiveTask_fx,
  archiveWorkspace as archiveWorkspace_fx,
  createGoal as createGoal_fx,
  createMilestone as createMilestone_fx,
  createTask as createTask_fx,
  createWorkspace as createWorkspace_fx,
  createWorkstream as createWorkstream_fx,
  getBoardState as getBoardState_fx,
  getScratchpad as getScratchpad_fx,
  initRepo,
  nextMilestoneOrder as nextMilestoneOrder_fx,
  recentActions as recentActions_fx,
  restoreGoal as restoreGoal_fx,
  restoreMilestone as restoreMilestone_fx,
  restoreTask as restoreTask_fx,
  restoreWorkspace as restoreWorkspace_fx,
  setScratchpad as setScratchpad_fx,
  subscribe,
  updateMilestone as updateMilestone_fx,
  updateTask as updateTask_fx,
  updateWorkspace as updateWorkspace_fx,
} from "./repo.ts";
import { proposePlan } from "./supervisor.ts";
import { rebuildTokens, workerApi } from "./worker.ts";

// repo operations are Effects; run them at the HTTP boundary.
const R = Effect.runPromise;
const actionsForEntity = (...a: Parameters<typeof actionsForEntity_fx>) =>
  R(actionsForEntity_fx(...a));
const approveMilestone = (...a: Parameters<typeof approveMilestone_fx>) =>
  R(approveMilestone_fx(...a));
const createGoal = (...a: Parameters<typeof createGoal_fx>) => R(createGoal_fx(...a));
const createMilestone = (...a: Parameters<typeof createMilestone_fx>) =>
  R(createMilestone_fx(...a));
const createWorkspace = (...a: Parameters<typeof createWorkspace_fx>) =>
  R(createWorkspace_fx(...a));
const updateWorkspace = (...a: Parameters<typeof updateWorkspace_fx>) =>
  R(updateWorkspace_fx(...a));
const createTask = (...a: Parameters<typeof createTask_fx>) => R(createTask_fx(...a));
const createWorkstream = (...a: Parameters<typeof createWorkstream_fx>) =>
  R(createWorkstream_fx(...a));
const getBoardState = (...a: Parameters<typeof getBoardState_fx>) => R(getBoardState_fx(...a));
const getScratchpad = (...a: Parameters<typeof getScratchpad_fx>) => R(getScratchpad_fx(...a));
const nextMilestoneOrder = (...a: Parameters<typeof nextMilestoneOrder_fx>) =>
  R(nextMilestoneOrder_fx(...a));
const recentActions = (...a: Parameters<typeof recentActions_fx>) => R(recentActions_fx(...a));
const setScratchpad = (...a: Parameters<typeof setScratchpad_fx>) => R(setScratchpad_fx(...a));
const archiveMilestone = (...a: Parameters<typeof archiveMilestone_fx>) =>
  R(archiveMilestone_fx(...a));
const restoreMilestone = (...a: Parameters<typeof restoreMilestone_fx>) =>
  R(restoreMilestone_fx(...a));
const archiveWorkspace = (...a: Parameters<typeof archiveWorkspace_fx>) =>
  R(archiveWorkspace_fx(...a));
const restoreWorkspace = (...a: Parameters<typeof restoreWorkspace_fx>) =>
  R(restoreWorkspace_fx(...a));
const archiveGoal = (...a: Parameters<typeof archiveGoal_fx>) => R(archiveGoal_fx(...a));
const restoreGoal = (...a: Parameters<typeof restoreGoal_fx>) => R(restoreGoal_fx(...a));
const archiveTask = (...a: Parameters<typeof archiveTask_fx>) => R(archiveTask_fx(...a));
const restoreTask = (...a: Parameters<typeof restoreTask_fx>) => R(restoreTask_fx(...a));
const archivedEntities = (...a: Parameters<typeof archivedEntities_fx>) =>
  R(archivedEntities_fx(...a));
const updateMilestone = (...a: Parameters<typeof updateMilestone_fx>) =>
  R(updateMilestone_fx(...a));
const updateTask = (...a: Parameters<typeof updateTask_fx>) => R(updateTask_fx(...a));

const PUBLIC = `${ROOT}/public`;

await initDb(); // open PGlite + apply migrations
await initRepo(); // load the action seq counter
await rebuildTokens(); // worker token cache from the task rows
console.log(`[powdermonkey] ready`);
await resumePending();

const rid = (p: string) => `${p}-${crypto.randomUUID().slice(0, 8)}`;

const app = new Elysia()
  .use(workerApi)
  // Reusable body schemas — referenced by name on the create routes.
  .model({
    newWorkspace: t.Object({
      id: t.Optional(t.String()),
      name: t.String(),
      repoPath: t.Optional(t.String()),
      subpath: t.Optional(t.String()),
      secrets: t.Optional(t.Record(t.String(), t.String())),
      envFiles: t.Optional(t.Array(t.String())),
      setup: t.Optional(t.String()),
    }),
    newGoal: t.Object({
      id: t.Optional(t.String()),
      workspaceId: t.String(),
      title: t.String(),
      intent: t.Optional(t.String()),
    }),
    newWorkstream: t.Object({
      id: t.Optional(t.String()),
      goalId: t.String(),
      startingPlanId: t.Optional(t.String()),
      title: t.String(),
    }),
    newTask: t.Object({
      id: t.Optional(t.String()),
      workstreamId: t.Optional(t.String()),
      planId: t.Optional(t.String()),
      title: t.String(),
      objective: t.String(),
      kind: t.Optional(t.String()),
    }),
  })
  // ---- reads ----
  .get("/api/health", () => ({ ok: true }))
  .get("/api/board", () => getBoardState())
  .get("/api/actions", ({ query }) => recentActions(Number(query.limit ?? 200)))
  .get("/api/running", () => runningSessions())
  // ---- entity creation (operator) ----
  .post(
    "/api/workspaces",
    async ({ body }) => {
      const id = body.id ?? rid("wks");
      await createWorkspace(
        { ...body, id },
        { actor: "operator", action: "workspace_created", summary: body.name },
      );
      return { ok: true, id };
    },
    { body: "newWorkspace" },
  )
  .patch("/api/workspaces/:id", async ({ params, body }) => {
    const b = body as Record<string, unknown>;
    await updateWorkspace(params.id, b, {
      actor: "operator",
      action: "workspace_updated",
      summary: typeof b.name === "string" ? b.name : "edited",
    });
    return { ok: true };
  })
  .post(
    "/api/goals",
    async ({ body }) => {
      const id = body.id ?? rid("goal");
      await createGoal(
        { ...body, id },
        { actor: "operator", action: "goal_created", summary: body.title },
      );
      return { ok: true, id };
    },
    { body: "newGoal" },
  )
  .post(
    "/api/workstreams",
    async ({ body }) => {
      const id = body.id ?? rid("ws");
      await createWorkstream(
        { ...body, id, status: "active" },
        { actor: "operator", action: "workstream_created", summary: body.title },
      );
      return { ok: true, id };
    },
    { body: "newWorkstream" },
  )
  .post(
    "/api/tasks",
    async ({ body }) => {
      const id = body.id ?? rid("task");
      await createTask(
        { ...body, id, kind: (body.kind ?? "implementation") as TaskKind, status: "planned" },
        { actor: "operator", action: "task_created", summary: body.title },
      );
      return { ok: true, id };
    },
    { body: "newTask" },
  )
  // ---- everything scoped to a single task ----
  .group("/api/tasks/:id", (g) =>
    g
      .post(
        "/answer",
        async ({ params, body }) => {
          await updateTask(
            params.id,
            { question: null, status: "working" },
            { actor: "operator", action: "operator_answered", summary: body.answer },
          );
          void maybeResume(params.id);
          return { ok: true };
        },
        { body: t.Object({ answer: t.String() }) },
      )
      .post(
        "/comment",
        async ({ params, body }) => {
          await updateTask(
            params.id,
            { status: "working" },
            { actor: "operator", action: "operator_commented", summary: body.comment },
          );
          void maybeResume(params.id);
          return { ok: true };
        },
        { body: t.Object({ comment: t.String() }) },
      )
      .post("/approve-review", async ({ params }) => {
        await updateTask(
          params.id,
          { status: "working" },
          { actor: "operator", action: "operator_approved_review" },
        );
        void maybeResume(params.id);
        return { ok: true };
      })
      .post("/done", async ({ params }) => {
        await updateTask(
          params.id,
          { status: "done" },
          { actor: "operator", action: "operator_marked_task_done" },
        );
        return { ok: true };
      })
      .post("/abandon", async ({ params }) => {
        await updateTask(
          params.id,
          { status: "abandoned" },
          { actor: "operator", action: "operator_abandoned_task" },
        );
        return { ok: true };
      })
      .post("/launch", ({ params, body }) => launchTask(params.id, body ?? {}), {
        body: t.Optional(
          t.Object({ sessionId: t.Optional(t.String()), branch: t.Optional(t.String()) }),
        ),
      })
      .get("/diff", ({ params }) => taskDiff(params.id))
      .get("/actions", ({ params }) => actionsForEntity("task", params.id)),
  )
  // ---- supervisor / plans ----
  .post("/api/goals/:id/plan", ({ params }) => {
    void proposePlan(params.id).then((r) => {
      if (!r.ok) console.log(`[supervisor] propose failed for ${params.id}: ${r.error}`);
      else console.log(`[supervisor] proposed ${r.planId} with ${r.taskCount} tasks`);
    });
    return { ok: true, status: "planning" };
  })
  // ---- Milestones (ordered, gated sequence under a goal) ----
  .post("/api/goals/:id/milestones", async ({ params, body }) => {
    const b = body as { title: string; detail?: string };
    const orderHint = await nextMilestoneOrder(params.id);
    return await createMilestone(
      {
        id: `ms-${crypto.randomUUID().slice(0, 8)}`,
        goalId: params.id,
        title: b.title,
        detail: b.detail ?? null,
        orderHint,
      },
      { actor: "operator", action: "milestone_created", summary: b.title },
    );
  })
  .patch("/api/milestones/:id", async ({ params, body }) => {
    const b = body as { title?: string; detail?: string; status?: string; orderHint?: number };
    const patch: Record<string, unknown> = {};
    if (typeof b.title === "string") patch.title = b.title;
    if (typeof b.detail === "string") patch.detail = b.detail;
    if (typeof b.status === "string") patch.status = b.status;
    if (typeof b.orderHint === "number") patch.orderHint = b.orderHint;
    return (
      (await updateMilestone(params.id, patch, {
        actor: "operator",
        action: "milestone_updated",
        summary: b.title ?? b.status ?? "updated",
      })) ?? null
    );
  })
  .post("/api/milestones/:id/approve", async ({ params }) => {
    const r = await approveMilestone(params.id, {
      actor: "operator",
      action: "milestone_approved",
      summary: "approved",
    });
    return { ok: !!r };
  })
  .post("/api/milestones/:id/archive", async ({ params }) => {
    await archiveMilestone(params.id, {
      actor: "operator",
      action: "milestone_archived",
      summary: "archived",
    });
    return { ok: true };
  })
  .post("/api/milestones/:id/restore", async ({ params }) => {
    await restoreMilestone(params.id, {
      actor: "operator",
      action: "milestone_restored",
      summary: "restored",
    });
    return { ok: true };
  })
  // ---- Archive / restore (nothing is ever deleted) ----
  .get("/api/archived", () => archivedEntities())
  .post("/api/workspaces/:id/archive", async ({ params }) => {
    await archiveWorkspace(params.id, {
      actor: "operator",
      action: "workspace_archived",
      summary: "archived",
    });
    return { ok: true };
  })
  .post("/api/workspaces/:id/restore", async ({ params }) => {
    await restoreWorkspace(params.id, {
      actor: "operator",
      action: "workspace_restored",
      summary: "restored",
    });
    return { ok: true };
  })
  .post("/api/goals/:id/archive", async ({ params }) => {
    await archiveGoal(params.id, {
      actor: "operator",
      action: "goal_archived",
      summary: "archived",
    });
    return { ok: true };
  })
  .post("/api/goals/:id/restore", async ({ params }) => {
    await restoreGoal(params.id, {
      actor: "operator",
      action: "goal_restored",
      summary: "restored",
    });
    return { ok: true };
  })
  .post("/api/tasks/:id/archive", async ({ params }) => {
    await archiveTask(params.id, {
      actor: "operator",
      action: "task_archived",
      summary: "archived",
    });
    return { ok: true };
  })
  .post("/api/tasks/:id/restore", async ({ params }) => {
    await restoreTask(params.id, {
      actor: "operator",
      action: "task_restored",
      summary: "restored",
    });
    return { ok: true };
  })
  .group("/api/plans/:id", (g) =>
    g
      .post("/approve", ({ params, body }) => approvePlan(params.id, body?.launch ?? false), {
        body: t.Optional(t.Object({ launch: t.Optional(t.Boolean()) })),
      })
      .post("/reject", ({ params }) => rejectPlan(params.id)),
  )
  // ---- Scratchpad (global catchall notes) ----
  .get("/api/scratchpad", async () => ({ content: await getScratchpad() }))
  .put("/api/scratchpad", async ({ body }) => {
    await setScratchpad((body as { content: string }).content, {
      actor: "operator",
      action: "scratchpad_edited",
      summary: "edited the scratchpad",
    });
    return { ok: true };
  })
  // ---- Chat threads (sidebar Recents) + message history ----
  .get("/api/threads", async () =>
    (await listThreads()).map((t) => ({
      id: t.id,
      title: t.title,
      archived: !!t.archivedAt,
      lastMessageAt: t.updatedAt,
    })),
  )
  .post("/api/threads", async ({ body }) => {
    const t = await ensureThread((body as { clientId?: string } | undefined)?.clientId);
    return { id: t.id, title: t.title, archived: !!t.archivedAt };
  })
  .get("/api/threads/:id", async ({ params }) => {
    const t = await getThread(params.id);
    return t
      ? {
          id: t.id,
          title: t.title,
          archived: !!t.archivedAt,
          kind: t.kind,
          goalId: t.goalId,
          workspaceId: t.workspaceId,
        }
      : null;
  })
  .patch("/api/threads/:id", async ({ params, body }) => {
    const b = body as { title?: string; archived?: boolean; workspaceId?: string | null };
    if (typeof b?.title === "string") await renameThread(params.id, b.title);
    if (typeof b?.archived === "boolean") await setArchived(params.id, b.archived);
    if (b && "workspaceId" in b) await setWorkspace(params.id, b.workspaceId ?? null);
    return { ok: true };
  })
  .delete("/api/threads/:id", async ({ params }) => {
    await archiveThread(params.id);
    return { ok: true };
  })
  .get("/api/threads/:id/messages", ({ params }) => getMessages(params.id))
  .post("/api/threads/:id/messages", async ({ params, body }) => {
    await appendMessage(params.id, (body as { message: unknown }).message);
    return { ok: true };
  })

  // ---- Chat: stream a conversational claude -p (NDJSON) ----
  .post(
    "/api/chat",
    ({ body, request }) =>
      new Response(
        streamChat(
          body as { threadId: string; text: string; bind?: any; screen?: any },
          request.signal,
        ),
        {
          headers: { "content-type": "application/x-ndjson; charset=utf-8" },
        },
      ),
  )
  // ---- WebSocket: broadcast each action (with its diff) over a typed feed ----
  .ws("/ws", {
    response: t.Union([
      t.Object({ type: t.Literal("hello") }),
      t.Object({
        type: t.Literal("action"),
        action: t.Object({
          id: t.String(),
          seq: t.Number(),
          at: t.String(),
          actor: t.String(),
          action: t.String(),
          entityType: t.String(),
          entityId: t.String(),
          summary: t.Union([t.String(), t.Null()]),
          diff: t.Record(t.String(), t.Object({ from: t.Any(), to: t.Any() })),
        }),
      }),
    ]),
    open(ws) {
      const unsub = subscribe((action) => ws.send({ type: "action", action }));
      (ws.data as { unsub?: () => void }).unsub = unsub;
      ws.send({ type: "hello" });
    },
    close(ws) {
      (ws.data as { unsub?: () => void }).unsub?.();
    },
  })
  // ---- static SPA ----
  .get("/*", ({ path, set }) => {
    const index = `${PUBLIC}/index.html`;
    const candidate = `${PUBLIC}${path}`;
    if (path !== "/" && existsSync(candidate) && !candidate.endsWith("/"))
      return Bun.file(candidate);
    if (existsSync(index)) return Bun.file(index);
    set.headers["content-type"] = "text/html";
    return `<!doctype html><html><body style="font-family:system-ui;padding:2rem">
      <h1>PowderMonkey</h1><p>Server is up. Run <code>bun run build:web</code>.</p>
      <p>API: <a href="/api/board">/api/board</a></p></body></html>`;
  })
  .listen(PORT);

console.log(`[powdermonkey] listening on http://localhost:${PORT}`);

export type App = typeof app;
