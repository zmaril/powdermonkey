// The dispatcher: durable orchestration over the live tables, written in Effect.
// It launches tasks (worktree + worker backend), tracks running processes, and on
// boot resumes any task left mid-flight. Internally everything is Effect
// composition with typed errors; each public function runs the Effect at its edge
// and maps the error channel to a result, so callers still see plain Promises.

import { Effect } from "effect";
import { type LaunchSpec, makeBackend, type WorkerHandle } from "./backend.ts";
import { BASE_URL as BASE, WORKTREE_ROOT } from "./config.ts";
import { Invalid, NotFound, SpawnError } from "./fx/errors.ts";
import { git, gitHead } from "./fx/git.ts";
import * as Repo from "./repo.ts";
import { mintToken } from "./worker.ts";
import { runWorkerExit } from "./worker-health.ts";

const backend = makeBackend();

interface Running {
  taskId: string;
  sessionId: string;
  handle: WorkerHandle;
  exited: boolean;
  pendingResume?: boolean;
}
const running = new Map<string, Running>();

// ---- shared resolvers ----
const getTaskOr = (id: string) =>
  Repo.getTask(id).pipe(
    Effect.flatMap((t) =>
      t ? Effect.succeed(t) : Effect.fail(new NotFound({ what: "task", id })),
    ),
  );

const workspaceOr = (taskId: string) =>
  Repo.workspaceForTask(taskId).pipe(
    Effect.flatMap((p) =>
      p?.repoPath
        ? Effect.succeed(p as NonNullable<typeof p> & { repoPath: string })
        : Effect.fail(new Invalid({ reason: "no repoPath for task's workspace" })),
    ),
  );

// ---- diff ----
export type DiffResult = {
  ok: boolean;
  error?: string;
  stat?: string;
  diff?: string;
  truncated?: boolean;
};

const taskDiffFx = (taskId: string) =>
  Effect.gen(function* () {
    const task = yield* getTaskOr(taskId);
    if (!task.branch) {
      return yield* Effect.fail(new Invalid({ reason: "task has no branch yet (not launched)" }));
    }
    const workspace = yield* workspaceOr(taskId);
    const range = `${task.baseRef ?? "HEAD"}...${task.branch}`;
    const stat = (yield* git(["-C", workspace.repoPath, "diff", "--stat", range])).out;
    const full = yield* git(["-C", workspace.repoPath, "diff", range]);
    if (!full.ok) {
      return yield* Effect.fail(
        new Invalid({ reason: `git diff failed: ${full.out.slice(0, 200)}` }),
      );
    }
    const MAX = 200_000;
    const truncated = full.out.length > MAX;
    return { ok: true, stat, diff: truncated ? full.out.slice(0, MAX) : full.out, truncated };
  });

export const taskDiff = (taskId: string): Promise<DiffResult> =>
  Effect.runPromise(
    taskDiffFx(taskId).pipe(
      Effect.catchTags({
        NotFound: () => Effect.succeed({ ok: false, error: "unknown task" } as DiffResult),
        Invalid: (e) => Effect.succeed({ ok: false, error: e.reason } as DiffResult),
        RepoError: (e) => Effect.succeed({ ok: false, error: `db error (${e.op})` } as DiffResult),
        GitError: () => Effect.succeed({ ok: false, error: "git failed" } as DiffResult),
      }),
    ),
  );

// ---- launch ----
export interface LaunchResult {
  ok: boolean;
  error?: string;
  token?: string;
  sessionId?: string;
  branch?: string;
  worktreePath?: string;
  pid?: number;
  bootstrapUrl?: string;
  bootstrapLine?: string;
}

const launchTaskFx = (
  taskId: string,
  opts: { sessionId?: string; branch?: string; resume?: boolean },
) =>
  Effect.gen(function* () {
    const task = yield* getTaskOr(taskId);
    const workspace = yield* workspaceOr(taskId);

    const sessionId = opts.sessionId ?? task.sessionId ?? `ses-${crypto.randomUUID().slice(0, 8)}`;
    const branch = opts.branch ?? task.branch ?? `pm/${taskId}`;
    const worktreePath = task.worktreePath ?? `${WORKTREE_ROOT}/${workspace.id}/${taskId}`;
    const baseRef = task.baseRef ?? (yield* gitHead(workspace.repoPath));
    const token = (opts.resume ? task.token : null) ?? mintToken(taskId);
    const bootstrapUrl = `${BASE}/api/w/${token}`;

    const existing = yield* Repo.getSession(sessionId);
    if (!existing) {
      yield* Repo.createSession(
        {
          id: sessionId,
          workstreamId: task.workstreamId,
          currentTaskId: taskId,
          taskIds: [taskId],
          status: "working",
        },
        { actor: "dispatcher", action: "session_started" },
      );
    } else {
      yield* Repo.updateSession(
        sessionId,
        { currentTaskId: taskId, status: "working" },
        { actor: "dispatcher", action: "session_attached" },
      );
    }

    yield* Repo.updateTask(
      taskId,
      { sessionId, branch, worktreePath, baseRef, token, status: "launched" },
      {
        actor: "dispatcher",
        action: opts.resume ? "task_resumed" : "task_launched",
        summary: branch,
      },
    );

    const spec: LaunchSpec = {
      taskId,
      sessionId,
      title: task.title,
      objective: task.objective,
      repoPath: workspace.repoPath,
      baseRef,
      branch,
      worktreePath,
      bootstrapUrl,
      token,
      resume: opts.resume,
      subpath: workspace.subpath ?? undefined,
      secrets: workspace.secrets ?? undefined,
      envFiles: workspace.envFiles ?? undefined,
      setup: workspace.setup ?? undefined,
    };

    const handle = yield* Effect.tryPromise({
      try: () => backend.launch(spec),
      catch: (cause) => new SpawnError({ cause }),
    });

    yield* Effect.sync(() => {
      const rec: Running = { taskId, sessionId, handle, exited: false };
      running.set(sessionId, rec);
      handle.exited?.then((code) => {
        rec.exited = true;
        void runWorkerExit({
          taskId,
          code,
          logPath: handle.logPath,
          pendingResume: !!rec.pendingResume,
          resume: () => maybeResume(taskId),
        });
      });
    });

    return {
      ok: true,
      token,
      sessionId,
      branch,
      worktreePath,
      pid: handle.pid,
      bootstrapUrl,
      bootstrapLine: `For your task and how to report status: curl -s ${bootstrapUrl}`,
    } as LaunchResult;
  });

export const launchTask = (
  taskId: string,
  opts: { sessionId?: string; branch?: string; resume?: boolean } = {},
): Promise<LaunchResult> =>
  Effect.runPromise(
    launchTaskFx(taskId, opts).pipe(
      Effect.catchTags({
        NotFound: (e) => Effect.succeed({ ok: false, error: `unknown ${e.what}` } as LaunchResult),
        Invalid: (e) => Effect.succeed({ ok: false, error: e.reason } as LaunchResult),
        RepoError: (e) =>
          Effect.succeed({ ok: false, error: `db error (${e.op})` } as LaunchResult),
        GitError: () => Effect.succeed({ ok: false, error: "git failed" } as LaunchResult),
        SpawnError: (e) => Effect.succeed({ ok: false, error: String(e.cause) } as LaunchResult),
      }),
    ),
  );

export function runningSessions() {
  return [...running.values()].map((r) => ({
    taskId: r.taskId,
    sessionId: r.sessionId,
    pid: r.handle.pid,
    exited: r.exited,
  }));
}

// ---- approve / reject plan ----
export type ApproveResult = {
  ok: boolean;
  error?: string;
  workstreamId?: string;
  taskIds?: string[];
  launched?: boolean;
};

const approvePlanFx = (planId: string, launch: boolean) =>
  Effect.gen(function* () {
    const plan = yield* Repo.getPlan(planId).pipe(
      Effect.flatMap((p) =>
        p ? Effect.succeed(p) : Effect.fail(new NotFound({ what: "plan", id: planId })),
      ),
    );
    if (plan.status !== "proposed") {
      return yield* Effect.fail(new Invalid({ reason: `plan is ${plan.status}` }));
    }
    yield* Repo.updatePlan(
      planId,
      { status: "approved" },
      { actor: "operator", action: "plan_approved", summary: plan.title },
    );
    const workstreamId = `ws-${planId}`;
    yield* Repo.createWorkstream(
      {
        id: workstreamId,
        goalId: plan.goalId,
        startingPlanId: planId,
        title: plan.title,
        status: "active",
      },
      { actor: "operator", action: "workstream_created", summary: plan.title },
    );
    const milestoneId = yield* Repo.activeMilestoneId(plan.goalId);
    const taskIds: string[] = [];
    for (const pt of plan.proposedTasks ?? []) {
      const taskId = `task-${crypto.randomUUID().slice(0, 8)}`;
      yield* Repo.createTask(
        {
          id: taskId,
          workstreamId,
          milestoneId,
          planId,
          title: pt.title,
          objective: pt.objective,
          kind: pt.kind,
          status: "planned",
        },
        { actor: "supervisor", action: "task_created", summary: pt.title },
      );
      taskIds.push(taskId);
    }
    if (launch) {
      yield* Effect.forEach(
        taskIds,
        (id) =>
          launchTaskFx(id, {}).pipe(
            Effect.catchAll((e) => Effect.logWarning(`launch failed for ${id}: ${String(e)}`)),
          ),
        { discard: true },
      );
    }
    return { ok: true, workstreamId, taskIds, launched: launch } as ApproveResult;
  });

export const approvePlan = (planId: string, launch = false): Promise<ApproveResult> =>
  Effect.runPromise(
    approvePlanFx(planId, launch).pipe(
      Effect.catchTags({
        NotFound: () => Effect.succeed({ ok: false, error: "unknown plan" } as ApproveResult),
        Invalid: (e) => Effect.succeed({ ok: false, error: e.reason } as ApproveResult),
        RepoError: (e) =>
          Effect.succeed({ ok: false, error: `db error (${e.op})` } as ApproveResult),
      }),
    ),
  );

export const rejectPlan = (planId: string): Promise<{ ok: boolean }> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const plan = yield* Repo.getPlan(planId);
      if (plan) {
        yield* Repo.updatePlan(
          planId,
          { status: "rejected" },
          { actor: "operator", action: "plan_rejected", summary: plan.title },
        );
      }
      return { ok: true };
    }).pipe(Effect.catchAll(() => Effect.succeed({ ok: true }))),
  );

// ---- resume ----
const maybeResumeFx = (taskId: string) =>
  Effect.gen(function* () {
    const task = yield* Repo.getTask(taskId);
    if (!task?.worktreePath || !task.sessionId || task.archivedAt) return;
    const r = running.get(task.sessionId);
    if (r && !r.exited) {
      yield* Effect.sync(() => {
        r.pendingResume = true;
      });
      return;
    }
    yield* Effect.logInfo(`operator responded on ${taskId}; resuming worker`);
    yield* launchTaskFx(taskId, {
      sessionId: task.sessionId,
      branch: task.branch ?? undefined,
      resume: true,
    }).pipe(Effect.catchAll((e) => Effect.logWarning(`resume failed for ${taskId}: ${String(e)}`)));
  });

export const maybeResume = (taskId: string): Promise<void> =>
  Effect.runPromise(maybeResumeFx(taskId).pipe(Effect.catchAll(() => Effect.void)));

const resumePendingFx = Effect.gen(function* () {
  const resumable = (yield* Repo.tasksWithStatus(["launched", "working"])).filter(
    (t) => t.worktreePath,
  );
  if (!resumable.length) return;
  yield* Effect.logInfo(`resuming ${resumable.length} in-flight task(s)`);
  yield* Effect.forEach(
    resumable,
    (t) =>
      launchTaskFx(t.id, {
        sessionId: t.sessionId ?? undefined,
        branch: t.branch ?? undefined,
        resume: true,
      }).pipe(Effect.catchAll((e) => Effect.logWarning(`resume failed for ${t.id}: ${String(e)}`))),
    { discard: true },
  );
});

export const resumePending = (): Promise<void> =>
  Effect.runPromise(resumePendingFx.pipe(Effect.catchAll(() => Effect.void)));
