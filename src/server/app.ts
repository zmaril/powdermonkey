import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { TSchema } from "@sinclair/typebox";
import { Elysia, t } from "elysia";
import { goalRepo, milestoneRepo, noteRepo, phaseRepo, sessionRepo, taskRepo } from "./crud.ts";
import { dispatchTask, loadTaskPrompt } from "./dispatch.ts";
import { openSessionEditor } from "./editor.ts";
import { currentCloudPrs, syncCloudPrs } from "./github-watch.ts";
import { models } from "./models.ts";
import { loadPlan, planSchema } from "./plan.ts";
import { closePty, ptyExited, resizePty, spawnShell, writePty } from "./pty.ts";
import { reconcile } from "./reconcile.ts";
import {
  SUPERVISOR_ID,
  attachSessionPty,
  resizeSessionPty,
  startSupervisorPty,
  writeSessionPty,
} from "./session-pty.ts";
import { readSessionStatus } from "./session-status.ts";
import { listSessionTasks } from "./session-tasks.ts";
import { teleportTask } from "./teleport.ts";
import { landSession, startLocalSession, stopSession } from "./worktree.ts";

// Full CRUD for every vocab entity, plus the nested plan loader and the runtime
// dispatch/status routes. Eden Treaty consumes `App` (exported below) so the
// browser gets end-to-end types without hand-written fetch shapes.
//
// Request bodies are TypeBox schemas derived from the Drizzle tables (see
// models.ts) — Elysia validates them natively, so there's nothing hand-maintained
// to drift from schema.ts.

// biome-ignore lint/suspicious/noExplicitAny: HTTP body is validated by the route model; the repo carries the precise insert type.
type Repo = { [k: string]: (...args: any[]) => Promise<any> };

// Per-socket /pty handle. A socket either owns a *fresh* shell it spawned (the
// supervisor/repo shell, or a worktree fallback), or it's *attached* to a
// session's long-lived PTY (shared, multiplexed) — see session-pty.ts.
type PtyHandle =
  // biome-ignore lint/suspicious/noExplicitAny: native PTY handle (see pty.ts).
  { kind: "fresh"; proc: any } | { kind: "attach"; sessionId: number; detach: () => void };
const ptys = new Map<object, PtyHandle>();

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
// Body for the launch routes: the path `:id` is the primary task; `taskIds` may
// carry additional tasks to fold into the SAME session. We union them (primary
// first) and dedupe, so the UI can pass the whole multi-selection either way.
const launchBody = t.Optional(t.Object({ taskIds: t.Optional(t.Array(t.Number())) }));
function launchIds(idParam: string, body?: { taskIds?: number[] } | null): number[] {
  return [...new Set([Number(idParam), ...(body?.taskIds ?? [])])];
}

const tasksGroup = resource("tasks", taskRepo, models.tasks)
  .post(
    "/:id/dispatch",
    async ({ params, body, set }) => {
      const result = await dispatchTask(launchIds(params.id, body));
      if (!result.ok) set.status = 400;
      return result;
    },
    { body: launchBody },
  )
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
  // Accepts extra `taskIds` to fold several tasks into the one worktree session.
  .post(
    "/:id/start-local",
    async ({ params, body, set }) => {
      const result = await startLocalSession(launchIds(params.id, body));
      if (!result.ok) set.status = 400;
      return result;
    },
    { body: launchBody },
  )
  // Teleport a running cloud session down to a local worktree session, continuing
  // the same conversation via `claude --teleport <id>`.
  .post("/:id/teleport", async ({ params, set }) => {
    const result = await teleportTask(Number(params.id));
    if (!result.ok) set.status = 400;
    return result;
  })
  // Re-fetch the worker prompt + phase trailers for a task — the same content
  // start-local/dispatch hand to a worker, available read-only without starting one.
  .get("/:id/prompt", async ({ params, set }) => {
    const result = await loadTaskPrompt(Number(params.id));
    if (!result) set.status = 404;
    return result ?? { error: "not found" };
  });

// Sessions carry `land` (graceful teardown of finished work), `stop` (abort a
// running session) and `open-editor` (VS Code on the operator's machine) on top
// of CRUD.
const sessionsGroup = resource("sessions", sessionRepo, models.sessions)
  .post("/:id/land", async ({ params, set }) => {
    const result = await landSession(Number(params.id));
    if (!result.ok) set.status = 400;
    return result;
  })
  .post("/:id/stop", async ({ params, set }) => {
    const result = await stopSession(Number(params.id));
    if (!result.ok) set.status = 400;
    return result;
  })
  .post("/:id/open-editor", async ({ params, set }) => {
    const result = await openSessionEditor(Number(params.id));
    if (!result.ok) set.status = 400;
    return result;
  });

export const app = new Elysia()
  .get("/health", () => ({ ok: true }))
  // Nested, id-less plan loader — Elysia validates the body against the TypeBox
  // plan schema before the handler runs.
  .post("/plan", ({ body }) => loadPlan(body), { body: planSchema })
  // Reconcile progress from PM trailers on main. Also runs on a poll loop.
  .post("/reconcile", () => reconcile())
  // Poll GitHub for pm/task-* PRs now (set prUrl, wake reconcile on merge). The
  // github-watch loop does this every 10s; this triggers a pass on demand.
  .post("/github-sync", () => syncCloudPrs())
  // The watcher's latest PR state per task-linked PR (CI checks, mergeable, draft).
  // Live runtime data, not persisted — the Active panel reads it for status badges.
  .get("/cloud-prs", () => currentCloudPrs())
  // Every session↔task link. The browser intersects these with the sessions it
  // already holds to learn which tasks are active and which session each surfaces,
  // so one flat list serves both the live panes and the archive view.
  .get("/session-tasks", () => listSessionTasks())
  // Image upload from the web shell. The browser is remote, so a dropped image
  // has to land on the server filesystem first; we save it under data/uploads/
  // and return the absolute path, which the client then types into the PTY for
  // Claude Code to detect and attach.
  .post(
    "/upload",
    async ({ body }) => {
      const dir = join(process.env.PM_REPO_DIR ?? process.cwd(), "data", "uploads");
      mkdirSync(dir, { recursive: true });
      const safe = body.file.name.replace(/[^a-zA-Z0-9._-]/g, "_") || "image";
      const path = join(dir, `${Date.now()}-${safe}`);
      await Bun.write(path, body.file);
      return { path };
    },
    { body: t.Object({ file: t.File() }) },
  )
  // Forwarded shell streamed to xterm.js. Two modes:
  //   ?session=<id> → attach to that local session's long-lived `claude` PTY
  //                   (shared + replayed); falls back to a fresh shell in the
  //                   session's worktree if the PTY isn't live (e.g. post-restart).
  //   ?cwd=<path>   → a fresh plain shell at that path (a worktree).
  //   (neither)     → attach to the supervisor's OWN durable session (reserved
  //                   id 0), which lives in tmux and survives `--watch` restarts.
  // Server → client: binary PTY output. Client → server: JSON input/resize frames.
  .ws("/pty", {
    query: t.Object({ cwd: t.Optional(t.String()), session: t.Optional(t.String()) }),
    body: t.Object({
      type: t.String(),
      data: t.Optional(t.String()),
      cols: t.Optional(t.Number()),
      rows: t.Optional(t.Number()),
    }),
    async open(ws) {
      const send = (bytes: Uint8Array) => {
        try {
          ws.raw.send(bytes);
        } catch {}
      };

      // Which durable session to attach to: an explicit ?session=<id>, or — when
      // neither session nor cwd is given — the supervisor's own reserved session.
      const q = ws.data.query.cwd;
      let sessionId: number | null = null;
      if (ws.data.query.session) {
        const n = Number(ws.data.query.session);
        if (!Number.isNaN(n)) sessionId = n;
      } else if (!q) {
        startSupervisorPty(); // ensure the supervisor's tmux session is live first
        sessionId = SUPERVISOR_ID;
      }

      if (sessionId != null) {
        const detach = attachSessionPty(sessionId, send);
        if (detach) {
          ptys.set(ws.raw, { kind: "attach", sessionId, detach });
          return;
        }
        // No live PTY (tmux unavailable, or a worker session whose PTY didn't
        // survive): fall back to a fresh shell. The supervisor drops into Claude
        // at the repo dir; a worker gets a plain shell in its worktree.
        const isSupervisor = sessionId === SUPERVISOR_ID;
        const cwd = isSupervisor
          ? process.env.PM_REPO_DIR || process.cwd()
          : (await sessionRepo.get(sessionId))?.worktreePath ||
            process.env.PM_REPO_DIR ||
            process.cwd();
        if (!isSupervisor) {
          send(
            new TextEncoder().encode(
              "\x1b[2m[no live agent PTY — opening a shell here]\x1b[0m\r\n",
            ),
          );
        }
        const proc = spawnShell(cwd, send, isSupervisor ? undefined : "");
        ptys.set(ws.raw, { kind: "fresh", proc });
        ptyExited(proc).then(() => {
          try {
            ws.close();
          } catch {}
          ptys.delete(ws.raw);
        });
        return;
      }

      // ?cwd=<path> → a plain fresh worktree shell.
      const cwd = q || process.env.PM_REPO_DIR || process.cwd();
      const proc = spawnShell(cwd, send, "");
      ptys.set(ws.raw, { kind: "fresh", proc });
      ptyExited(proc).then(() => {
        try {
          ws.close();
        } catch {}
        ptys.delete(ws.raw);
      });
    },
    message(ws, msg) {
      const handle = ptys.get(ws.raw);
      if (!handle) return;
      if (handle.kind === "attach") {
        if (msg.type === "resize" && msg.cols && msg.rows)
          resizeSessionPty(handle.sessionId, msg.cols, msg.rows);
        else if (msg.type === "input" && msg.data != null)
          writeSessionPty(handle.sessionId, msg.data);
      } else {
        if (msg.type === "resize" && msg.cols && msg.rows)
          resizePty(handle.proc, msg.cols, msg.rows);
        else if (msg.type === "input" && msg.data != null) writePty(handle.proc, msg.data);
      }
    },
    close(ws) {
      const handle = ptys.get(ws.raw);
      if (!handle) return;
      ptys.delete(ws.raw);
      // Attached sockets just detach — the session PTY lives on. Fresh shells die.
      if (handle.kind === "attach") handle.detach();
      else closePty(handle.proc);
    },
  })
  // CRUD groups.
  .use(resource("goals", goalRepo, models.goals))
  .use(resource("milestones", milestoneRepo, models.milestones))
  .use(tasksGroup)
  .use(resource("phases", phaseRepo, models.phases))
  .use(sessionsGroup)
  .use(resource("notes", noteRepo, models.notes))
  // Static: bundled web app, SPA fallback to index.html.
  .get("/assets/*", ({ params }) => Bun.file(`public/assets/${params["*"]}`))
  .get("/*", () => Bun.file("public/index.html"));

export type App = typeof app;
