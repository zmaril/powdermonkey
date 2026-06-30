import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { TSchema } from "@sinclair/typebox";
import { getTableColumns, getTableName } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { P, match } from "ts-pattern";
import { Decision, OverrideSource, ProposalStatus, SessionState } from "../shared/types.ts";
import { applyProposal, decideChange } from "./apply.ts";
import { cancelTask, completePhase, completeTask, reopenPhase, reopenTask } from "./completion.ts";
import { cors } from "./cors.ts";
import { goalRepo, milestoneRepo, noteRepo, phaseRepo, sessionRepo, taskRepo } from "./crud.ts";
import { pg } from "./db.ts";
import { dispatchTask, loadTaskPrompt } from "./dispatch.ts";
import { openSessionEditor } from "./editor.ts";
import { proposeFollowup } from "./followups.ts";
import { currentCloudPrs, syncCloudPrs } from "./github-watch.ts";
import { models } from "./models.ts";
import { PUBLIC_DIR } from "./paths.ts";
import { loadPlan, planSchema } from "./plan.ts";
import { getFileContents, getPrReview, postPrComment, submitReview } from "./pr-review.ts";
import {
  type CreateProposalInput,
  createProposal,
  decideProposal,
  getProposal,
  listPending,
  listProposals,
  proposalCreateBody,
} from "./proposals.ts";
import { closePty, ptyExited, resizePty, spawnShell, writePty } from "./pty.ts";
import { reconcile } from "./reconcile.ts";
import {
  goals as goalsTable,
  milestones as milestonesTable,
  notes as notesTable,
  phases as phasesTable,
  proposals as proposalsTable,
  pullRequests as pullRequestsTable,
  sessionTasks as sessionTasksTable,
  sessions as sessionsTable,
  tasks as tasksTable,
} from "./schema.ts";
import {
  SUPERVISOR_ID,
  attachSessionPty,
  resizeSessionPty,
  startSupervisorPty,
  writeSessionPty,
} from "./session-pty.ts";
import { listSessionTasks } from "./session-tasks.ts";
import { getAutoRebase, setAutoRebase } from "./settings.ts";
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

// Per-socket teardown for /sync: each connection owns one PGlite live.changes
// subscription, dropped when the socket closes.
const syncSubs = new Map<object, () => void>();

// The tables the browser mirrors as TanStack DB collections. The SELECT and the
// primary-key column are derived from the Drizzle schema — adding a table here is the
// only per-table server code. We stream EVERY row (live + archived); the browser's
// live queries filter to non-archived for the working panes and to archived/merged
// for the Archive pane, so one collection set serves both.
const SYNC_TABLES: Record<string, { sql: string; key: string }> = Object.fromEntries(
  [
    goalsTable,
    milestonesTable,
    tasksTable,
    phasesTable,
    sessionsTable,
    sessionTasksTable,
    notesTable,
    pullRequestsTable,
    proposalsTable,
    // biome-ignore lint/suspicious/noExplicitAny: heterogeneous pgTable objects, introspected generically.
  ].map((tbl: any) => {
    const name = getTableName(tbl);
    const cols = getTableColumns(tbl);
    const pk =
      (Object.values(cols) as Array<{ name: string; primary: boolean }>).find((c) => c.primary)
        ?.name ?? "id";
    return [name, { sql: `SELECT * FROM "${name}"`, key: pk }];
  }),
);

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
const launchBody = t.Optional(
  t.Object({ taskIds: t.Optional(t.Array(t.Number())), comment: t.Optional(t.String()) }),
);
function launchIds(idParam: string, body?: { taskIds?: number[] } | null): number[] {
  return [...new Set([Number(idParam), ...(body?.taskIds ?? [])])];
}

// Who made the call on an override route (complete/cancel): `operator` (the UI,
// the default) or `supervisor` (the supervisor agent acting on the operator's
// behalf). `reconciled` is deliberately not accepted — that's the reconciler's to
// stamp. Defaults to `operator` when the body is absent so the UI can stay terse.
const sourceBody = t.Optional(
  t.Object({
    source: t.Optional(
      t.Union([t.Literal(OverrideSource.Operator), t.Literal(OverrideSource.Supervisor)]),
    ),
  }),
);
function decisionSource(body?: { source?: OverrideSource } | null): OverrideSource {
  return body?.source ?? OverrideSource.Operator;
}

const tasksGroup = resource("tasks", taskRepo, models.tasks)
  .post(
    "/:id/dispatch",
    async ({ params, body, set }) => {
      const result = await dispatchTask(launchIds(params.id, body), body?.comment);
      if (!result.ok) set.status = 400;
      return result;
    },
    { body: launchBody },
  )
  // Start a local session: worktree on pm/task-<id> + a session row + trailer block.
  // Accepts extra `taskIds` to fold several tasks into the one worktree session.
  .post(
    "/:id/start-local",
    async ({ params, body, set }) => {
      const result = await startLocalSession(launchIds(params.id, body), {
        comment: body?.comment,
      });
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
  })
  // Override decisions (the non-reconciled path): close a task by hand for work that
  // never landed a trailer (`complete` → merged), abandon it (`cancel` → cancelled),
  // or walk either back (`reopen`). Each stamps `decision_source` with the caller's
  // `source` (operator default, or supervisor). Reconciled rows are never touched.
  .post(
    "/:id/complete",
    async ({ params, body, set }) => {
      const row = await completeTask(Number(params.id), decisionSource(body));
      if (!row) set.status = 404;
      return row ?? { error: "not found" };
    },
    { body: sourceBody },
  )
  .post(
    "/:id/cancel",
    async ({ params, body, set }) => {
      const row = await cancelTask(Number(params.id), decisionSource(body));
      if (!row) set.status = 404;
      return row ?? { error: "not found" };
    },
    { body: sourceBody },
  )
  .post("/:id/reopen", async ({ params, set }) => {
    const row = await reopenTask(Number(params.id));
    if (!row) set.status = 404;
    return row ?? { error: "not found" };
  });

// Phases carry the same complete/reopen on top of CRUD — the grain at which a
// squash-dropped trailer is most often patched up by hand.
const phasesGroup = resource("phases", phaseRepo, models.phases)
  .post(
    "/:id/complete",
    async ({ params, body, set }) => {
      const row = await completePhase(Number(params.id), decisionSource(body));
      if (!row) set.status = 404;
      return row ?? { error: "not found" };
    },
    { body: sourceBody },
  )
  .post("/:id/reopen", async ({ params, set }) => {
    const row = await reopenPhase(Number(params.id));
    if (!row) set.status = 404;
    return row ?? { error: "not found" };
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

// Proposals: a pending change-set the operator decides on. Authored when the
// supervisor is SUGGESTING a change; reviewed as markdown (GET /:id/markdown renders
// the proposal's projected plan) and approved/rejected/applied. The decision +
// apply logic lives in proposals.ts / apply.ts.
const proposalsGroup = new Elysia({ prefix: "/proposals" })
  // List pending — the operator's decision queue. Before "/:id" so it wins the route.
  .get("/pending", () => listPending())
  .get("/", ({ query }) => listProposals({ status: query.status }), {
    query: t.Object({ status: t.Optional(t.String()) }),
  })
  .get("/:id", async ({ params, set }) => {
    const row = await getProposal(Number(params.id));
    if (!row) set.status = 404;
    return row ?? { error: "not found" };
  })
  .post("/", ({ body }) => createProposal(body as CreateProposalInput), {
    body: proposalCreateBody,
  })
  .post("/:id/approve", async ({ params, set }) => {
    const row = await decideProposal(Number(params.id), ProposalStatus.Approved);
    if (!row) set.status = 400;
    return row ?? { error: "proposal not found or not pending" };
  })
  .post("/:id/reject", async ({ params, set }) => {
    const row = await decideProposal(Number(params.id), ProposalStatus.Rejected);
    if (!row) set.status = 400;
    return row ?? { error: "proposal not found or not pending" };
  })
  // Inline per-change decision: accept ONE change (and its create-subtree) — applied
  // immediately — or reject it. The change leaves the proposal either way; the proposal
  // closes once empty. Backs the ghost cards' ✓/✗ in the Backlog.
  .post(
    "/:id/decide",
    async ({ params, body, set }) => {
      const result = await decideChange(Number(params.id), body.changeIndex, body.decision);
      if (!result.ok) set.status = "conflicts" in result && result.conflicts ? 409 : 400;
      return result;
    },
    {
      body: t.Object({
        changeIndex: t.Number(),
        decision: t.Union([t.Literal(Decision.Accept), t.Literal(Decision.Reject)]),
      }),
    },
  )
  .post("/:id/apply", async ({ params, set }) => {
    const result = await applyProposal(Number(params.id));
    if (!result.ok) set.status = "conflicts" in result && result.conflicts ? 409 : 400;
    return result;
  });

// Follow-ups: the capture channel for a worker handing an out-of-scope find back to
// the operator. A local worker (which can reach $PM_URL) POSTs here; the handler
// authors a pending `create task` proposal (see followups.ts), so it lands in the
// same review queue as any other proposal. A cloud worker can't reach this — it
// leaves a `<!-- pm:followup -->` PR comment that github-watch slurps into the same
// path. Just the title is required; body (context) and sourceTaskId (the task the
// worker was on, which picks the milestone) sharpen the proposal.
const followupsGroup = new Elysia({ prefix: "/followups" }).post(
  "/",
  async ({ body, set }) => {
    const result = await proposeFollowup(body);
    if (!result.ok) set.status = 400;
    return result;
  },
  {
    body: t.Object({
      title: t.String(),
      body: t.Optional(t.String()),
      sourceTaskId: t.Optional(t.Number()),
    }),
  },
);

export const app = new Elysia()
  // Cross-origin access for desktop/remote clients (Tauri, or a browser over
  // Tailscale). Inert same-origin. Must be first so it wraps every route.
  .use(cors)
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
  // Persisted in the pull_requests table, so it's served from last-known state on
  // boot — the Active panel reads it for status badges.
  .get("/cloud-prs", () => currentCloudPrs())
  // Runtime operator settings (in-memory, reset on restart). `autoRebase` gates the
  // watcher's auto @claude-rebase ask, so the Active pane can pause/resume it.
  .get("/settings", () => ({ autoRebase: getAutoRebase() }))
  .post(
    "/settings",
    async ({ body }) => {
      await setAutoRebase(body.autoRebase);
      return { autoRebase: getAutoRebase() };
    },
    { body: t.Object({ autoRebase: t.Boolean() }) },
  )
  // In-app PR review: a PR's diff (raw patch per file) + its inline review comments,
  // so review happens here instead of bouncing to github.com. Backed by `gh api`
  // (or PM_PR_FIXTURE_DIR for offline/demo). 502 when GitHub is unreachable.
  .get(
    "/prs/:number/review",
    async ({ params, set }) => {
      const result = await getPrReview(Number(params.number));
      if (!result.ok) {
        set.status = result.status;
        return { error: result.error };
      }
      return result.review;
    },
    { params: t.Object({ number: t.String() }) },
  )
  // Full old+new contents of one file, fetched on demand so the diff can expand
  // collapsed context (only when the operator asks — a large PR won't pull every blob).
  .get(
    "/prs/:number/file",
    async ({ params, query, set }) => {
      const result = await getFileContents(
        Number(params.number),
        query.path,
        query.base ?? "",
        query.head ?? "",
      );
      if (!result.ok) {
        set.status = result.status;
        return { error: result.error };
      }
      return { oldText: result.oldText, newText: result.newText };
    },
    {
      params: t.Object({ number: t.String() }),
      query: t.Object({
        path: t.String(),
        base: t.Optional(t.String()),
        head: t.Optional(t.String()),
      }),
    },
  )
  // Post an inline review comment (or a threaded reply). Outward-facing write —
  // the UI confirms before calling. Echoes the created comment back.
  .post(
    "/prs/:number/comments",
    async ({ params, body, set }) => {
      const result = await postPrComment(Number(params.number), body);
      if (!result.ok) {
        set.status = result.status;
        return { error: result.error };
      }
      return result.comment;
    },
    {
      params: t.Object({ number: t.String() }),
      body: t.Object({
        body: t.String(),
        commitId: t.String(),
        path: t.String(),
        line: t.Number(),
        side: t.Union([t.Literal("LEFT"), t.Literal("RIGHT")]),
        inReplyTo: t.Optional(t.Number()),
      }),
    },
  )
  // Submit a whole review at once — all draft comments + a verdict (Approve /
  // Request changes / Comment) — as ONE GitHub review, so a watching session sees a
  // single event instead of one per comment.
  .post(
    "/prs/:number/review-submit",
    async ({ params, body, set }) => {
      const result = await submitReview(Number(params.number), body);
      if (!result.ok) {
        set.status = result.status;
        return { error: result.error };
      }
      return { ok: true };
    },
    {
      params: t.Object({ number: t.String() }),
      body: t.Object({
        event: t.Union([t.Literal("APPROVE"), t.Literal("REQUEST_CHANGES"), t.Literal("COMMENT")]),
        body: t.String(),
        commitId: t.String(),
        comments: t.Array(
          t.Object({
            path: t.String(),
            line: t.Number(),
            side: t.Union([t.Literal("LEFT"), t.Literal("RIGHT")]),
            startLine: t.Optional(t.Number()),
            startSide: t.Optional(t.Union([t.Literal("LEFT"), t.Literal("RIGHT")])),
            body: t.String(),
          }),
        ),
      }),
    },
  )
  // Every session<->task link. The browser intersects these with the sessions it
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
      // Spawn a fresh shell, register it, and tear the socket down when it exits.
      const spawnFresh = (cwd: string, startup?: string) => {
        const proc = spawnShell(cwd, send, startup);
        ptys.set(ws.raw, { kind: "fresh", proc });
        ptyExited(proc).then(() => {
          try {
            ws.close();
          } catch {}
          ptys.delete(ws.raw);
        });
      };
      // Control frames go out as text (the client tells them from binary PTY
      // output by type). "session-ended" tells the browser the session is gone for
      // good so it can show an end-state instead of a blank/dead terminal.
      const sendEnded = () => {
        try {
          ws.raw.send(JSON.stringify({ type: "session-ended" }));
        } catch {}
        try {
          ws.close();
        } catch {}
      };

      // Which durable session to attach to: an explicit ?session=<id>, or — when
      // neither session nor cwd is given — the supervisor's own reserved session.
      const { cwd: q, session } = ws.data.query;
      const sessionId = match({ session, q })
        .with({ session: P.string.minLength(1) }, ({ session }) => {
          const n = Number(session);
          return Number.isNaN(n) ? null : n;
        })
        .with({ q: P.union(undefined, "") }, () => {
          startSupervisorPty(); // ensure the supervisor's tmux session is live first
          return SUPERVISOR_ID;
        })
        .otherwise(() => null);

      if (sessionId != null) {
        const detach = attachSessionPty(sessionId, send, sendEnded);
        if (detach) {
          ptys.set(ws.raw, { kind: "attach", sessionId, detach });
          return;
        }
        const isSupervisor = sessionId === SUPERVISOR_ID;
        // No live PTY and this is a worker session that has already ended (landed,
        // stopped, or merge-archived): don't quietly spawn a fresh shell on a dead
        // session — tell the client so it shows the end-state. The supervisor (id 0)
        // never ends, so it always falls through to the recovery shell below.
        if (!isSupervisor) {
          const row = await sessionRepo.get(sessionId);
          if (
            !row ||
            row.archivedAt ||
            row.state === SessionState.Idle ||
            row.state === SessionState.Stopped
          ) {
            sendEnded();
            return;
          }
        }
        // No live PTY (tmux unavailable, or a worker session whose PTY didn't
        // survive): fall back to a fresh shell. The supervisor drops into Claude
        // at the repo dir; a worker gets a plain shell in its worktree.
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
        spawnFresh(cwd, isSupervisor ? undefined : "");
        return;
      }

      // ?cwd=<path> → a plain fresh worktree shell. The "Open a shell" action on an
      // ended session passes its old worktree, which land/merge has usually removed —
      // fall back to the repo dir so the shell always lands somewhere real.
      const repoDir = process.env.PM_REPO_DIR || process.cwd();
      spawnFresh(q && existsSync(q) ? q : repoDir, "");
    },
    message(ws, msg) {
      const handle = ptys.get(ws.raw);
      if (!handle) return;
      // The handle is one of two shapes (attach to a shared session PTY, or own a
      // fresh shell); pick the matching resize/write pair, then apply it once.
      const [resize, write] = match(handle)
        .with(
          { kind: "attach" },
          (h) =>
            [
              (c: number, r: number) => resizeSessionPty(h.sessionId, c, r),
              (d: string) => writeSessionPty(h.sessionId, d),
            ] as const,
        )
        .with(
          { kind: "fresh" },
          (h) =>
            [
              (c: number, r: number) => resizePty(h.proc, c, r),
              (d: string) => writePty(h.proc, d),
            ] as const,
        )
        .exhaustive();
      if (msg.type === "resize" && msg.cols && msg.rows) resize(msg.cols, msg.rows);
      else if (msg.type === "input" && msg.data != null) write(msg.data);
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
  // Realtime row-delta sync for the browser's TanStack DB collections — the sole
  // realtime channel (it replaced the old content-free /events ping, where the browser
  // refetched everything). This streams the actual row deltas (insert/update/delete)
  // straight from PGlite's `live.changes`, one socket per table (?table=tasks). Each
  // connection opens its OWN subscription, so its initial snapshot and the live stream
  // are atomic — a reconnecting client just gets a fresh snapshot, no offset/catch-up
  // bookkeeping. The browser half (src/web/collections.ts) applies these via
  // begin/write/commit. Reads are reactive; writes still go through the REST routes
  // and stream back here.
  .ws("/sync", {
    query: t.Object({ table: t.String() }),
    async open(ws) {
      const spec = SYNC_TABLES[ws.data.query.table];
      if (!spec) {
        ws.close();
        return;
      }
      const send = (changes: unknown) => {
        try {
          ws.send(JSON.stringify({ changes }));
        } catch {}
      };
      // Partial update mode: an UPDATE delta carries only the changed columns (the
      // rest come back null), so the client merges by __changed_columns__.
      const lc = await pg.live.changes(spec.sql, [], spec.key);
      send(lc.initialChanges); // snapshot first (may be empty → client still readies)
      const onChange = (changes: unknown) => send(changes);
      lc.subscribe(onChange);
      syncSubs.set(ws.raw, () => lc.unsubscribe(onChange));
    },
    close(ws) {
      const off = syncSubs.get(ws.raw);
      syncSubs.delete(ws.raw);
      off?.();
    },
  })
  // CRUD groups.
  .use(resource("goals", goalRepo, models.goals))
  .use(resource("milestones", milestoneRepo, models.milestones))
  .use(tasksGroup)
  .use(phasesGroup)
  .use(sessionsGroup)
  .use(resource("notes", noteRepo, models.notes))
  .use(proposalsGroup)
  .use(followupsGroup)
  // Static: bundled web app, SPA fallback to index.html. Served from the package's
  // public/ (resolved via PUBLIC_DIR), not the cwd — a global install runs from the
  // operator's project dir, which has no bundle of its own.
  .get("/assets/*", ({ params }) => Bun.file(join(PUBLIC_DIR, "assets", params["*"])))
  .get("/*", () => Bun.file(join(PUBLIC_DIR, "index.html")));

export type App = typeof app;
