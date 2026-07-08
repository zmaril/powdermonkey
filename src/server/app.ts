import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { TSchema } from "@sinclair/typebox";
import { getTableColumns, getTableName } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { match, P } from "ts-pattern";
import {
  CommentAuthor,
  Decision,
  DispatchBackend,
  OverrideSource,
  ProposalStatus,
  SessionState,
  SyncMode,
} from "../shared/types.ts";
import { applyProposal, decideChange } from "./apply.ts";
import { dumpSnapshot, type SqlClient } from "./backup.ts";
import {
  exportSnapshotToBranch,
  exportSnapshotToPr,
  syncStatus,
  triggerSyncSoon,
} from "./backup-sync.ts";
import { getClaudeUsage } from "./claude-usage.ts";
import { appendComment, archiveComment, listComments, updateComment } from "./comments.ts";
import { completePhase, reopenPhase, reopenTask } from "./completion.ts";
import { cors } from "./cors.ts";
import {
  goalRepo,
  milestoneRepo,
  noteRepo,
  phaseRepo,
  repoRepo,
  sessionRepo,
  taskRepo,
} from "./crud.ts";
import { pg } from "./db.ts";
import { loadTaskPrompt } from "./dispatch.ts";
import { backendUsageSummary } from "./disponent-usage.ts";
import { openSessionEditor } from "./editor.ts";
import { getDisponent } from "./exe-dev.ts";
import { fanOutTasks } from "./fanout.ts";
import { proposeFollowup } from "./followups.ts";
import { currentCloudPrs, syncCloudPrs } from "./github-watch.ts";
import { resolveLocalAttachTarget } from "./local-disponent.ts";
import { models, taskKindSchema } from "./models.ts";
import {
  buildContext,
  planLoad,
  proposalsPending,
  reconcileOp,
  taskCancel,
  taskComplete,
  taskDispatch,
} from "./ops/index.ts";
import { PUBLIC_DIR } from "./paths.ts";
import { planSchema } from "./plan.ts";
import { getFileContents, getPrReview, postPrComment, submitReview } from "./pr-review.ts";
import {
  type CreateProposalInput,
  createProposal,
  decideProposal,
  getProposal,
  listProposals,
  proposalCreateBody,
} from "./proposals.ts";
import { closePty, ptyExited, resizePty, spawnShell, writePty } from "./pty.ts";
import { repoIconResponse } from "./repo-icon.ts";
import { listMyRepos, searchRepos } from "./repo-picker.ts";
import { registerRepo } from "./repo-register.ts";
import {
  goals as goalsTable,
  milestones as milestonesTable,
  notes as notesTable,
  phases as phasesTable,
  proposals as proposalsTable,
  pullRequests as pullRequestsTable,
  repos as reposTable,
  sessions as sessionsTable,
  sessionTasks as sessionTasksTable,
  taskComments as taskCommentsTable,
  tasks as tasksTable,
} from "./schema.ts";
import {
  type AttachTarget,
  attachSessionPty,
  resizeSessionPty,
  SUPERVISOR_ID,
  startSupervisorPty,
  writeSessionPty,
} from "./session-pty.ts";
import { listSessionTasks } from "./session-tasks.ts";
import { getSettings, patchSettings } from "./settings.ts";
import { teleportTask } from "./teleport.ts";
import { isDisponentLocal, landSession, startLocalSession, stopSession } from "./worktree.ts";

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

// The shared op context (db + disponent handle). The control routes below delegate
// to the op-table's handlers (src/server/ops) — the SAME handlers the `pm mcp` stdio
// server registers as tools — so one op definition backs both the REST route and the
// MCP tool. Built once; within this process it resolves to this server's store.
const opCtx = buildContext();

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
    taskCommentsTable,
    notesTable,
    reposTable,
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

// The two response-shaping idioms every route below repeats: 404 when a lookup
// misses, 400 when an action reports `{ ok: false }`. Factored out so each handler
// stays a one-liner and the status codes live in one place.
function orNotFound<T>(
  set: { status?: number | string },
  row: T | null | undefined,
): T | { error: string } {
  if (!row) {
    set.status = 404;
    return { error: "not found" };
  }
  return row;
}
function orBadRequest<T extends { ok: boolean }>(set: { status?: number | string }, result: T): T {
  if (!result.ok) set.status = 400;
  return result;
}

/** A CRUD route group: list / get / create / update / archive(DELETE) / restore. */
function resource(name: string, repo: Repo, body: { create: TSchema; update: TSchema }) {
  return new Elysia({ prefix: `/${name}` })
    .get("/", ({ query }) => repo.list({ includeArchived: query.archived === "true" }), {
      query: t.Object({ archived: t.Optional(t.String()) }),
    })
    .get("/:id", async ({ params, set }) => orNotFound(set, await repo.get(Number(params.id))))
    .post("/", ({ body: payload }) => repo.create(payload), { body: body.create })
    .patch(
      "/:id",
      async ({ params, body: payload, set }) =>
        orNotFound(set, await repo.update(Number(params.id), payload as Record<string, unknown>)),
      { body: body.update },
    )
    .delete("/:id", async ({ params, set }) =>
      orNotFound(set, await repo.archive(Number(params.id))),
    )
    .post("/:id/restore", async ({ params, set }) =>
      orNotFound(set, await repo.restore(Number(params.id))),
    );
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
  // Fan-out create: author one task spec across N repos → one task per repo, all under
  // the same milestone (see fanout.ts). The multi-select repo picker POSTs here instead
  // of the single-task create so "add the linter to three repos" is authored once.
  .post("/fan-out", async ({ body, set }) => orBadRequest(set, await fanOutTasks(body)), {
    body: t.Object({
      milestoneId: t.Number(),
      title: t.String({ minLength: 1 }),
      kind: t.Optional(taskKindSchema),
      description: t.Optional(t.String()),
      repoIds: t.Array(t.Number(), { minItems: 1 }),
      phases: t.Optional(t.Array(t.Object({ name: t.String({ minLength: 1 }) }))),
      position: t.Optional(t.Number()),
    }),
  })
  .post(
    "/:id/dispatch",
    async ({ params, body, set }) =>
      orBadRequest(
        set,
        await taskDispatch.handler(opCtx, {
          taskId: Number(params.id),
          taskIds: body?.taskIds,
          comment: body?.comment,
        }),
      ),
    { body: launchBody },
  )
  // Start a local session: worktree on pm/task-<id> + a session row + trailer block.
  // Accepts extra `taskIds` to fold several tasks into the one worktree session.
  .post(
    "/:id/start-local",
    async ({ params, body, set }) =>
      orBadRequest(
        set,
        await startLocalSession(launchIds(params.id, body), { comment: body?.comment }),
      ),
    { body: launchBody },
  )
  // Teleport a running cloud session down to a local worktree session, continuing
  // the same conversation via `claude --teleport <id>`.
  .post("/:id/teleport", async ({ params, set }) =>
    orBadRequest(set, await teleportTask(Number(params.id))),
  )
  // Re-fetch the worker prompt + phase trailers for a task — the same content
  // start-local/dispatch hand to a worker, available read-only without starting one.
  .get("/:id/prompt", async ({ params, set }) =>
    orNotFound(set, await loadTaskPrompt(Number(params.id))),
  )
  // Override decisions (the non-reconciled path): close a task by hand for work that
  // never landed a trailer (`complete` → merged), abandon it (`cancel` → cancelled),
  // or walk either back (`reopen`). Each stamps `decision_source` with the caller's
  // `source` (operator default, or supervisor). Reconciled rows are never touched.
  .post(
    "/:id/complete",
    async ({ params, body, set }) =>
      orNotFound(
        set,
        await taskComplete.handler(opCtx, {
          taskId: Number(params.id),
          source: decisionSource(body),
        }),
      ),
    { body: sourceBody },
  )
  .post(
    "/:id/cancel",
    async ({ params, body, set }) =>
      orNotFound(
        set,
        await taskCancel.handler(opCtx, {
          taskId: Number(params.id),
          source: decisionSource(body),
        }),
      ),
    { body: sourceBody },
  )
  .post("/:id/reopen", async ({ params, set }) =>
    orNotFound(set, await reopenTask(Number(params.id))),
  )
  // The task's diary — one-line comments (see comments.ts). List reads oldest
  // first (live rows only); append is zero-ceremony; PATCH edits a line in place;
  // DELETE archives it (the same soft delete as every other entity). Changes
  // stream to the browser through the task_comments synced collection.
  .get("/:id/comments", ({ params }) => listComments(Number(params.id)))
  .post(
    "/:id/comments",
    async ({ params, body, set }) =>
      orNotFound(set, await appendComment(Number(params.id), body.body, body.author)),
    {
      body: t.Object({
        body: t.String({ minLength: 1 }),
        // Who's speaking — operator (default) or supervisor, same split as sourceBody.
        author: t.Optional(
          t.Union([t.Literal(CommentAuthor.Operator), t.Literal(CommentAuthor.Supervisor)]),
        ),
      }),
    },
  )
  .patch(
    "/:id/comments/:commentId",
    async ({ params, body, set }) =>
      orNotFound(set, await updateComment(Number(params.id), Number(params.commentId), body.body)),
    { body: t.Object({ body: t.String({ minLength: 1 }) }) },
  )
  .delete("/:id/comments/:commentId", async ({ params, set }) =>
    orNotFound(set, await archiveComment(Number(params.id), Number(params.commentId))),
  );

// Phases carry the same complete/reopen on top of CRUD — the grain at which a
// squash-dropped trailer is most often patched up by hand.
const phasesGroup = resource("phases", phaseRepo, models.phases)
  .post(
    "/:id/complete",
    async ({ params, body, set }) =>
      orNotFound(set, await completePhase(Number(params.id), decisionSource(body))),
    { body: sourceBody },
  )
  .post("/:id/reopen", async ({ params, set }) =>
    orNotFound(set, await reopenPhase(Number(params.id))),
  );

// Sessions carry `land` (graceful teardown of finished work), `stop` (abort a
// running session) and `open-editor` (VS Code on the operator's machine) on top
// of CRUD.
const sessionsGroup = resource("sessions", sessionRepo, models.sessions)
  .post("/:id/land", async ({ params, set }) =>
    orBadRequest(set, await landSession(Number(params.id))),
  )
  .post("/:id/stop", async ({ params, set }) =>
    orBadRequest(set, await stopSession(Number(params.id))),
  )
  .post("/:id/open-editor", async ({ params, set }) =>
    orBadRequest(set, await openSessionEditor(Number(params.id))),
  );

// Repos carry two routes on top of CRUD: the identity icon — the cached
// favicon/avatar (resolved lazily on the first ask — see repo-icon.ts), 404 when
// nothing resolved (the UI falls back to the repo's color swatch) — and
// `register`, the picker's confirm path. Register is fork-first: a slug the
// operator can't push to is forked (`gh repo fork --clone=false`) and the fork is
// registered with `upstream` recording the source (repo-register.ts). Idempotent
// on the live set, so re-picking an added repo just returns its row.
const reposGroup = resource("repos", repoRepo, models.repos)
  .get("/:id/icon", async ({ params, set }) => {
    const res = await repoIconResponse(Number(params.id));
    if (res) return res;
    set.status = 404;
    return { error: "no icon" };
  })
  .post(
    "/register",
    async ({ body, set }) => {
      const result = await registerRepo(body.slug);
      if (!result.ok) set.status = 502;
      return result;
    },
    { body: t.Object({ slug: t.String({ pattern: "^[^/\\s]+/[^/\\s]+$" }) }) },
  );

// Proposals: a pending change-set the operator decides on. Authored when the
// supervisor is SUGGESTING a change; reviewed as markdown (GET /:id/markdown renders
// the proposal's projected plan) and approved/rejected/applied. The decision +
// apply logic lives in proposals.ts / apply.ts.
const proposalsGroup = new Elysia({ prefix: "/proposals" })
  // List pending — the operator's decision queue. Before "/:id" so it wins the route.
  .get("/pending", () => proposalsPending.handler(opCtx, {}))
  .get("/", ({ query }) => listProposals({ status: query.status }), {
    query: t.Object({ status: t.Optional(t.String()) }),
  })
  .get("/:id", async ({ params, set }) => orNotFound(set, await getProposal(Number(params.id))))
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
// The picker's read sources (docs/vocabulary.md § Repo): the operator's own repos
// and a public GitHub search, both through the operator's authed `gh`. 502 when gh
// is missing/unauthed/unreachable — the picker surfaces the message in place.
const ghGroup = new Elysia({ prefix: "/gh" })
  .get("/repos", async ({ set }) => {
    const result = await listMyRepos();
    if (!result.ok) set.status = 502;
    return result;
  })
  .get(
    "/search",
    async ({ query, set }) => {
      const result = await searchRepos(query.q);
      if (!result.ok) set.status = 502;
      return result;
    },
    { query: t.Object({ q: t.String({ minLength: 1 }) }) },
  );

const followupsGroup = new Elysia({ prefix: "/followups" }).post(
  "/",
  async ({ body, set }) => orBadRequest(set, await proposeFollowup(body)),
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
  .post("/plan", ({ body }) => planLoad.handler(opCtx, body), { body: planSchema })
  // Reconcile progress from PM trailers on main. Also runs on a poll loop.
  .post("/reconcile", () => reconcileOp.handler(opCtx, {}))
  // Poll GitHub for pm/task-* PRs now (set prUrl, wake reconcile on merge). The
  // github-watch loop does this every 10s; this triggers a pass on demand.
  .post("/github-sync", () => syncCloudPrs())
  // The watcher's latest PR state per task-linked PR (CI checks, mergeable, draft).
  // Persisted in the pull_requests table, so it's served from last-known state on
  // boot — the Active panel reads it for status badges.
  .get("/cloud-prs", () => currentCloudPrs())
  // On-demand logical backup of the whole store — a version-independent JSON snapshot
  // (see backup.ts). Served from the live connection because the supervisor holds the
  // single writer lock; the CLI `powdermonkey backup` just saves this response.
  .get("/backup", async ({ set }) => {
    const snap = await dumpSnapshot(pg as unknown as SqlClient, new Date().toISOString());
    set.headers["content-disposition"] =
      `attachment; filename="pm-backup-${snap.meta.takenAt.replace(/[:.]/g, "-")}.json"`;
    return snap;
  })
  // On-demand export of the store snapshot to git: a fresh branch, and optionally a PR
  // opened for it. Distinct from autosync's one durable branch — each export is its own
  // point-in-time archive (see backup-sync.ts). `target: "pr"` pushes + opens a PR;
  // `target: "branch"` just commits (push controls whether it also lands on origin).
  .post(
    "/backup/export",
    async ({ body, set }) => {
      try {
        if (body.target === "pr") {
          return await exportSnapshotToPr({ base: body.base, title: body.title });
        }
        const branch =
          body.branch ?? `powdermonkey-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
        return await exportSnapshotToBranch(branch, { push: body.push ?? false });
      } catch (e) {
        set.status = 500;
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
    {
      body: t.Object({
        target: t.Union([t.Literal("branch"), t.Literal("pr")]),
        branch: t.Optional(t.String()),
        base: t.Optional(t.String()),
        title: t.Optional(t.String()),
        push: t.Optional(t.Boolean()),
      }),
    },
  )
  // Autosync status: mode/branch, last-synced time, last commit, and any error — the
  // "surface last-synced status" the UI reads (also polled by the CLI).
  .get("/backup/status", () => syncStatus())
  // The operator's Claude usage/limits (rolling 5-hour + weekly windows), read from
  // the same OAuth usage endpoint Claude Code's `/usage` uses. Best-effort: returns
  // `available: false` with a reason when there's no login / the API is down, never
  // an error. The global status bar polls this. See docs/claude-usage-spike.md.
  .get("/claude/usage", () => getClaudeUsage())
  // Per-backend usage/cost meters, rolled up from disponent's Usage event stream
  // (accumulated onto each session by the poll loop — see disponent-usage.ts).
  // Additive observation: this never gates progress, which reads off main's
  // trailers. Backends with no Usage events honestly read 0. The status bar polls
  // this alongside /claude/usage.
  .get("/backends/usage", async () => ({ backends: await backendUsageSummary() }))
  // Persisted operator settings (single-row, survives restart). `autoRebase` gates the
  // watcher's auto @claude-rebase ask; `syncMode`/`syncBranch` configure data-durability
  // autosync; `dispatchBackend` + `exe*` pick and configure the cloud-dispatch backend.
  // A partial POST patches only the keys it carries. Turning autosync on (mode → non-off)
  // kicks an immediate sync so the durable branch is seeded without waiting for a write.
  // pm's runtime registry: the env × agent × model rows disponent can dispatch to
  // (its offerings table), read live from the lazily-opened engine. The Settings
  // dispatch picker is driven from this instead of hardcoded backend literals. A
  // disponent hiccup is non-fatal — return an empty registry and the UI falls back
  // to its known backends rather than blanking the settings pane.
  .get("/offerings", async () => {
    try {
      return await getDisponent().offerings();
    } catch (e) {
      console.warn("offerings unavailable (non-fatal):", e instanceof Error ? e.message : e);
      return [];
    }
  })
  .get("/settings", () => getSettings())
  .post(
    "/settings",
    async ({ body }) => {
      const next = await patchSettings(body);
      if (body.syncMode && body.syncMode !== SyncMode.Off) triggerSyncSoon();
      return next;
    },
    {
      body: t.Object({
        autoRebase: t.Optional(t.Boolean()),
        syncMode: t.Optional(
          t.Union([t.Literal(SyncMode.Off), t.Literal(SyncMode.Local), t.Literal(SyncMode.Push)]),
        ),
        syncBranch: t.Optional(t.String()),
        dispatchBackend: t.Optional(
          t.Union([t.Literal(DispatchBackend.ExeDev), t.Literal(DispatchBackend.ClaudeRemote)]),
        ),
        exeTemplate: t.Optional(t.String()),
        exeTtydPort: t.Optional(t.Integer({ minimum: 1, maximum: 65535 })),
        exeClaudeFlags: t.Optional(t.String()),
        exeAutoTeardown: t.Optional(t.Boolean()),
      }),
    },
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
        .with({ session: P.string.minLength(1) }, ({ session: s }) => {
          const n = Number(s);
          return Number.isNaN(n) ? null : n;
        })
        .with({ q: P.union(undefined, "") }, () => {
          startSupervisorPty(); // ensure the supervisor's tmux session is live first
          return SUPERVISOR_ID;
        })
        .otherwise(() => null);

      if (sessionId != null) {
        const isSupervisor = sessionId === SUPERVISOR_ID;
        const row = isSupervisor ? null : await sessionRepo.get(sessionId);

        // A disponent-local session's agent lives in DISPONENT's tmux (its socket +
        // `dsp-<uid>`), not pm's `pm-session-<id>`. Resolve that attach target from
        // disponent's typed Session fields so the terminal reaches the real agent.
        let target: AttachTarget | undefined;
        if (row && isDisponentLocal(row) && row.vmName) {
          const resolved = await resolveLocalAttachTarget(row.vmName);
          target = resolved ?? undefined;
          // Disponent-local + still running but no attach target resolvable — this
          // shouldn't happen for a live local session. Fail honestly rather than
          // silently dropping into an unrelated fresh shell in the worktree.
          if (!target && row.state === SessionState.Running && !row.archivedAt) {
            send(
              new TextEncoder().encode(
                "\x1b[2m[disponent agent tmux not resolvable — cannot attach]\x1b[0m\r\n",
              ),
            );
            sendEnded();
            return;
          }
        }

        const detach = attachSessionPty(sessionId, send, sendEnded, target);
        if (detach) {
          ptys.set(ws.raw, { kind: "attach", sessionId, detach });
          return;
        }
        // No live PTY and this is a worker session that has already ended (landed,
        // stopped, or merge-archived): don't quietly spawn a fresh shell on a dead
        // session — tell the client so it shows the end-state. The supervisor (id 0)
        // never ends, so it always falls through to the recovery shell below.
        if (!isSupervisor) {
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
          : row?.worktreePath || process.env.PM_REPO_DIR || process.cwd();
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
  .use(reposGroup)
  .use(ghGroup)
  .use(proposalsGroup)
  .use(followupsGroup)
  // Static: bundled web app, SPA fallback to index.html. Served from the package's
  // public/ (resolved via PUBLIC_DIR), not the cwd — a global install runs from the
  // operator's project dir, which has no bundle of its own.
  .get("/assets/*", ({ params }) => Bun.file(join(PUBLIC_DIR, "assets", params["*"])))
  .get("/*", () => Bun.file(join(PUBLIC_DIR, "index.html")));

export type App = typeof app;
