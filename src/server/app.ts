import type { TSchema } from "@sinclair/typebox";
import { Elysia, t } from "elysia";
import { goalRepo, milestoneRepo, phaseRepo, sessionRepo, taskRepo } from "./crud.ts";
import { dispatchTask } from "./dispatch.ts";
import { models } from "./models.ts";
import { loadPlan, planSchema } from "./plan.ts";
import { closePty, ptyExited, resizePty, spawnShell, writePty } from "./pty.ts";
import { reconcile } from "./reconcile.ts";
import { readSessionStatus } from "./session-status.ts";
import { landSession, startLocalSession } from "./worktree.ts";

// Full CRUD for every vocab entity, plus the nested plan loader and the runtime
// dispatch/status routes. Eden Treaty consumes `App` (exported below) so the
// browser gets end-to-end types without hand-written fetch shapes.
//
// Request bodies are TypeBox schemas derived from the Drizzle tables (see
// models.ts) — Elysia validates them natively, so there's nothing hand-maintained
// to drift from schema.ts.

// biome-ignore lint/suspicious/noExplicitAny: HTTP body is validated by the route model; the repo carries the precise insert type.
type Repo = { [k: string]: (...args: any[]) => Promise<any> };

// Live PTYs keyed by the underlying socket, one per open /pty WebSocket.
// biome-ignore lint/suspicious/noExplicitAny: PTY handle is not typed (see pty.ts).
const ptys = new Map<object, any>();

/** A CRUD route group: list / get / create / update / archive(DELETE) / restore. */
function resource(name: string, repo: Repo, body: { create: TSchema; update: TSchema }) {
  return new Elysia({ prefix: `/${name}` })
    .get("/", ({ query }) => repo.list({ includeArchived: query.archived === "true" }), {
      query: t.Object({ archived: t.Optional(t.String()) }),
    })
    .get("/:id", async ({ params, set }) => {
      const row = await repo.get(Number(params.id));
      if (!row) set.status = 404;
      return row ?? { error: "not found" };
    })
    .post("/", ({ body }) => repo.create(body), { body: body.create })
    .patch(
      "/:id",
      async ({ params, body, set }) => {
        const row = await repo.update(Number(params.id), body as Record<string, unknown>);
        if (!row) set.status = 404;
        return row ?? { error: "not found" };
      },
      { body: body.update },
    )
    .delete("/:id", async ({ params, set }) => {
      const row = await repo.archive(Number(params.id));
      if (!row) set.status = 404;
      return row ?? { error: "not found" };
    })
    .post("/:id/restore", async ({ params, set }) => {
      const row = await repo.restore(Number(params.id));
      if (!row) set.status = 404;
      return row ?? { error: "not found" };
    });
}

// Tasks carry runtime routes (dispatch/status) on top of CRUD. Keeping them in the
// same group means Eden sees one coherent /tasks subtree.
const tasksGroup = resource("tasks", taskRepo, models.tasks)
  .post("/:id/dispatch", async ({ params, set }) => {
    const result = await dispatchTask(Number(params.id));
    if (!result.ok) set.status = 400;
    return result;
  })
  .post("/:id/status", async ({ params, set }) => {
    const task = await taskRepo.get(Number(params.id));
    if (!task?.sessionUrl) {
      set.status = 400;
      return { ok: false as const, error: "task has no session" };
    }
    const result = await readSessionStatus(task.sessionUrl);
    if (result.ok) await taskRepo.update(task.id, { sessionState: result.state });
    else set.status = 502;
    return result;
  })
  // Start a local session: worktree on pm/task-<id> + a session row + trailer block.
  .post("/:id/start-local", async ({ params, set }) => {
    const result = await startLocalSession(Number(params.id));
    if (!result.ok) set.status = 400;
    return result;
  });

// Sessions carry a `land` route (tear down the worktree) on top of CRUD.
const sessionsGroup = resource("sessions", sessionRepo, models.sessions).post(
  "/:id/land",
  async ({ params, set }) => {
    const result = await landSession(Number(params.id));
    if (!result.ok) set.status = 400;
    return result;
  },
);

export const app = new Elysia()
  .get("/health", () => ({ ok: true }))
  // Nested, id-less plan loader — Elysia validates the body against the TypeBox
  // plan schema before the handler runs.
  .post("/plan", ({ body }) => loadPlan(body), { body: planSchema })
  // Reconcile progress from PM trailers on main. Also runs on a poll loop.
  .post("/reconcile", () => reconcile())
  // Forwarded shell: a PTY login shell streamed to xterm.js in the browser. Open
  // with ?cwd=<path> (e.g. a session's worktree); defaults to the repo dir.
  // Server → client: binary PTY output. Client → server: JSON input/resize frames.
  .ws("/pty", {
    query: t.Object({ cwd: t.Optional(t.String()) }),
    body: t.Object({
      type: t.String(),
      data: t.Optional(t.String()),
      cols: t.Optional(t.Number()),
      rows: t.Optional(t.Number()),
    }),
    open(ws) {
      const q = ws.data.query.cwd;
      const cwd = q || process.env.PM_REPO_DIR || process.cwd();
      // Supervisor shell (no cwd → repo dir) drops into Claude; worker worktree
      // shells (cwd set) are plain.
      const startup = q ? "" : undefined;
      const proc = spawnShell(
        cwd,
        (bytes) => {
          try {
            ws.raw.send(bytes);
          } catch {}
        },
        startup,
      );
      ptys.set(ws.raw, proc);
      ptyExited(proc).then(() => {
        try {
          ws.close();
        } catch {}
        ptys.delete(ws.raw);
      });
    },
    message(ws, msg) {
      const proc = ptys.get(ws.raw);
      if (!proc) return;
      if (msg.type === "resize" && msg.cols && msg.rows) resizePty(proc, msg.cols, msg.rows);
      else if (msg.type === "input" && msg.data != null) writePty(proc, msg.data);
    },
    close(ws) {
      const proc = ptys.get(ws.raw);
      if (proc) {
        closePty(proc);
        ptys.delete(ws.raw);
      }
    },
  })
  // CRUD groups.
  .use(resource("goals", goalRepo, models.goals))
  .use(resource("milestones", milestoneRepo, models.milestones))
  .use(tasksGroup)
  .use(resource("phases", phaseRepo, models.phases))
  .use(sessionsGroup)
  // Static: bundled web app, SPA fallback to index.html.
  .get("/assets/*", ({ params }) => Bun.file(`public/assets/${params["*"]}`))
  .get("/*", () => Bun.file("public/index.html"));

export type App = typeof app;
