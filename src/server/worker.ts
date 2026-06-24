// Token-scoped, self-describing worker API (Effect-native). A claude -p worker is
// given ONE line in its prompt: `curl -s $BASE/api/w/$TOKEN`. That endpoint
// returns its task plus every action it can take. Each handler resolves the token
// (failing NotFound → 404) then runs its body as an Effect; `runWorker` centralizes
// the resolve + error→HTTP mapping so the handlers are just the meaningful work.

import { and, isNotNull, isNull } from "drizzle-orm";
import { Effect } from "effect";
import { Elysia, t } from "elysia";
import type { ArtifactKind } from "../shared/types.ts";
import { BASE_URL as BASE } from "./config.ts";
import { db } from "./db.ts";
import { NotFound, type RepoError } from "./fx/errors.ts";
import * as Repo from "./repo.ts";
import { tasks } from "./schema.ts";

// token -> taskId, cached in memory; rebuilt from the DB on boot.
const tokens = new Map<string, string>();

export const rebuildTokens = (): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const rows = yield* Effect.tryPromise({
        try: () =>
          db()
            .select({ id: tasks.id, token: tasks.token })
            .from(tasks)
            .where(and(isNull(tasks.archivedAt), isNotNull(tasks.token))),
        catch: () => new NotFound({ what: "tokens", id: "all" }),
      });
      yield* Effect.sync(() => {
        tokens.clear();
        for (const r of rows) if (r.token) tokens.set(r.token, r.id);
      });
    }).pipe(Effect.catchAll(() => Effect.void)),
  );

// Mint a fresh token for a task and cache it. The dispatcher persists it on the
// task row (which is what makes it durable).
export function mintToken(taskId: string): string {
  const token = `wtk_${crypto.randomUUID().replace(/-/g, "")}`;
  tokens.set(token, taskId);
  return token;
}

type TaskRow = typeof tasks.$inferSelect;
type Resolved = { task: TaskRow; repoPath?: string };

const resolveFx = (token: string) =>
  Effect.gen(function* () {
    const taskId = tokens.get(token);
    if (!taskId) return yield* Effect.fail(new NotFound({ what: "token", id: token }));
    const task = yield* Repo.getTask(taskId);
    if (!task || task.archivedAt)
      return yield* Effect.fail(new NotFound({ what: "task", id: taskId }));
    const workspace = yield* Repo.workspaceForTask(taskId);
    return { task, repoPath: workspace?.repoPath ?? undefined } as Resolved;
  });

// Resolve the token, run the handler body, map failures to HTTP.
const runWorker = <A>(
  token: string,
  set: { status?: number | string },
  f: (r: Resolved) => Effect.Effect<A, RepoError>,
): Promise<A | { error: string }> =>
  Effect.runPromise(
    resolveFx(token).pipe(
      Effect.flatMap(f),
      Effect.catchTags({
        NotFound: () =>
          Effect.sync(() => {
            set.status = 404;
            return { error: "unknown or expired worker token" };
          }),
        RepoError: (e) =>
          Effect.sync(() => {
            set.status = 500;
            return { error: `db error (${e.op})` };
          }),
      }),
    ),
  );

// The self-describing payload returned by the bootstrap GET.
function describe(token: string, task: TaskRow, repoPath?: string) {
  const root = `${BASE}/api/w/${token}`;
  const post = (path: string, body: Record<string, string>) => {
    const data = JSON.stringify(
      Object.fromEntries(Object.keys(body).map((k) => [k, `<${body[k]}>`])),
    );
    return `curl -s -X POST ${root}/${path} -H 'content-type: application/json' -d '${data}'`;
  };
  return {
    you_are:
      "a PowderMonkey worker. Report status by curling this API when something meaningful happens — do not poll in a loop.",
    task: {
      id: task.id,
      title: task.title,
      objective: task.objective,
      kind: task.kind,
      status: task.status,
      branch: task.branch,
      worktreePath: task.worktreePath,
      repoPath,
      lastProgress: task.lastProgress,
      openQuestion: task.question,
    },
    actions: [
      {
        name: "get_task",
        when: "to re-read your objective and current status",
        method: "GET",
        curl: `curl -s ${root}/task`,
      },
      {
        name: "inbox",
        when: "after you asked a question or requested review, to pick up the operator's answer/approval",
        method: "GET",
        curl: `curl -s ${root}/inbox`,
      },
      {
        name: "claim",
        when: "first, before doing any work, to register that you are on this task",
        method: "POST",
        body: { summary: "one line: what you are about to do" },
        curl: post("claim", { summary: "string" }),
      },
      {
        name: "progress",
        when: "when you reach a meaningful milestone (not every step)",
        method: "POST",
        body: { summary: "what changed / what you found" },
        curl: post("progress", { summary: "string" }),
      },
      {
        name: "question",
        when: "when you are blocked on a decision only the operator can make",
        method: "POST",
        body: { question: "the specific question" },
        curl: post("question", { question: "string" }),
      },
      {
        name: "artifact",
        when: "to attach output: a PR (branch+diff), a plan proposal, a task proposal, or a report",
        method: "POST",
        body: {
          kind: "pull_request|plan_proposal|task_proposal|investigation_report",
          summary: "string",
          ref: "branch name, file path, or url",
        },
        curl: post("artifact", { kind: "string", summary: "string", ref: "string" }),
      },
      {
        name: "review",
        when: "when your work is ready for the operator to review",
        method: "POST",
        body: { summary: "what is ready and where to look" },
        curl: post("review", { summary: "string" }),
      },
      {
        name: "blocked",
        when: "when you cannot proceed for a non-question reason (missing dep, broken env)",
        method: "POST",
        body: { reason: "what is blocking you" },
        curl: post("blocked", { reason: "string" }),
      },
    ],
    next: "Start by POSTing a claim, then work the objective. Attach a PR artifact and request review when done.",
  };
}

export const workerApi = new Elysia({ prefix: "/api/w" })
  .get("/:token", ({ params, set }) =>
    runWorker(params.token, set, (r) => Effect.succeed(describe(params.token, r.task, r.repoPath))),
  )
  .get("/:token/task", ({ params, set }) =>
    runWorker(params.token, set, (r) => Effect.succeed(r.task)),
  )
  .get("/:token/inbox", ({ params, query, set }) =>
    runWorker(params.token, set, (r) =>
      Effect.gen(function* () {
        const since = Number(query.since ?? 0);
        const acts = yield* Repo.actionsForEntity("task", r.task.id, since);
        const messages = acts
          .filter((a) => a.action.startsWith("operator_"))
          .map((a) => ({
            seq: a.seq,
            action: a.action,
            at: a.at,
            summary: a.summary,
            diff: a.diff,
          }));
        return { taskId: r.task.id, messages };
      }),
    ),
  )
  .post(
    "/:token/claim",
    ({ params, body, set }) =>
      runWorker(params.token, set, (r) =>
        Effect.gen(function* () {
          yield* Repo.createClaim(
            {
              id: `clm-${crypto.randomUUID().slice(0, 8)}`,
              taskId: r.task.id,
              sessionId: r.task.sessionId,
              summary: body.summary,
            },
            { actor: "worker", action: "claim_registered", summary: body.summary },
          );
          yield* Repo.updateTask(
            r.task.id,
            { status: "working" },
            { actor: "worker", action: "claim_registered", summary: body.summary },
          );
          return { ok: true };
        }),
      ),
    { body: t.Object({ summary: t.String() }) },
  )
  .post(
    "/:token/progress",
    ({ params, body, set }) =>
      runWorker(params.token, set, (r) =>
        Effect.gen(function* () {
          const promote = r.task.status === "planned" || r.task.status === "launched";
          yield* Repo.updateTask(
            r.task.id,
            { lastProgress: body.summary, ...(promote ? { status: "working" } : {}) },
            { actor: "worker", action: "worker_progressed", summary: body.summary },
          );
          return { ok: true };
        }),
      ),
    { body: t.Object({ summary: t.String() }) },
  )
  .post(
    "/:token/question",
    ({ params, body, set }) =>
      runWorker(params.token, set, (r) =>
        Effect.gen(function* () {
          yield* Repo.updateTask(
            r.task.id,
            { question: body.question, status: "waiting_for_me" },
            { actor: "worker", action: "worker_asked_question", summary: body.question },
          );
          return { ok: true, note: "moved to Needs Input. GET ../inbox to pick up the answer." };
        }),
      ),
    { body: t.Object({ question: t.String() }) },
  )
  .post(
    "/:token/artifact",
    ({ params, body, set }) =>
      runWorker(params.token, set, (r) =>
        Effect.gen(function* () {
          const artifactId = `art-${crypto.randomUUID().slice(0, 8)}`;
          yield* Repo.createArtifact(
            {
              id: artifactId,
              taskId: r.task.id,
              sessionId: r.task.sessionId,
              kind: body.kind as ArtifactKind,
              summary: body.summary,
              payload: { ref: body.ref },
            },
            { actor: "worker", action: "artifact_attached", summary: body.summary ?? body.kind },
          );
          return { ok: true, artifactId };
        }),
      ),
    {
      body: t.Object({
        kind: t.String(),
        summary: t.Optional(t.String()),
        ref: t.Optional(t.String()),
      }),
    },
  )
  .post(
    "/:token/review",
    ({ params, body, set }) =>
      runWorker(params.token, set, (r) =>
        Effect.gen(function* () {
          yield* Repo.updateTask(
            r.task.id,
            { status: "needs_review", lastProgress: body.summary },
            { actor: "worker", action: "worker_requested_review", summary: body.summary },
          );
          return { ok: true, note: "moved to Needs Input (review)." };
        }),
      ),
    { body: t.Object({ summary: t.String() }) },
  )
  .post(
    "/:token/blocked",
    ({ params, body, set }) =>
      runWorker(params.token, set, (r) =>
        Effect.gen(function* () {
          yield* Repo.updateTask(
            r.task.id,
            { question: body.reason, status: "blocked" },
            { actor: "worker", action: "worker_marked_blocked", summary: body.reason },
          );
          return { ok: true };
        }),
      ),
    { body: t.Object({ reason: t.String() }) },
  );
