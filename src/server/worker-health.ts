// Worker-failure visibility — written in Effect as an experiment. Classify a
// worker process exit and react: a worker that exits while still "working"
// (without asking a question, requesting review, or finishing) has crashed or
// stalled, so we mark the task `failed` and post a system message into its
// transcript instead of leaving it silently "working" forever.

import { Data, Effect, Match } from "effect";
import { RepoError } from "./fx/errors.ts";
import { getTask, updateTask } from "./repo.ts";
import type { TaskStatus } from "./schema.ts";

// ---- typed errors ----
class TaskNotFound extends Data.TaggedError("TaskNotFound")<{ taskId: string }> {}

// ---- the exit outcome, as a tagged enum ----
type ExitOutcome = Data.TaggedEnum<{
  Resume: object;
  Expected: { readonly status: TaskStatus };
  Failed: { readonly status: TaskStatus; readonly code: number };
}>;
const ExitOutcome = Data.taggedEnum<ExitOutcome>();

// Statuses where an exit means the worker is *resting* on purpose (it reached a
// waiting or terminal state), not crashing.
const RESTING: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "waiting_for_me",
  "needs_review",
  "blocked",
  "done",
  "abandoned",
  "failed",
]);

const classify = (status: TaskStatus, code: number, pendingResume: boolean): ExitOutcome =>
  pendingResume
    ? ExitOutcome.Resume()
    : RESTING.has(status)
      ? ExitOutcome.Expected({ status })
      : ExitOutcome.Failed({ status, code });

const getTaskE = (taskId: string) =>
  getTask(taskId).pipe(
    Effect.flatMap((t) => (t ? Effect.succeed(t) : Effect.fail(new TaskNotFound({ taskId })))),
  );

const markFailed = (taskId: string, code: number, logPath: string) => {
  const reason = code === 0 ? "stopped without finishing the task" : `crashed (exit code ${code})`;
  return updateTask(
    taskId,
    { status: "failed" },
    { actor: "dispatcher", action: "worker_failed", summary: `Worker ${reason}. Log: ${logPath}` },
  );
};

// Classify the exit and act. Never rejects — typed errors are logged.
export function runWorkerExit(opts: {
  taskId: string;
  code: number;
  logPath: string;
  pendingResume: boolean;
  resume: () => Promise<void>;
}): Promise<void> {
  const program = Effect.gen(function* () {
    const task = yield* getTaskE(opts.taskId);
    const outcome = classify(task.status, opts.code, opts.pendingResume);
    yield* Match.value(outcome).pipe(
      Match.tag("Resume", () =>
        Effect.tryPromise({
          try: opts.resume,
          catch: (cause) => new RepoError({ op: "resume", cause }),
        }),
      ),
      Match.tag("Expected", ({ status }) =>
        Effect.logInfo(`worker for task ${opts.taskId} exited at rest (${status})`),
      ),
      Match.tag("Failed", ({ code }) =>
        markFailed(opts.taskId, code, opts.logPath).pipe(
          Effect.tap(() => Effect.logWarning(`task ${opts.taskId} marked failed (exit ${code})`)),
        ),
      ),
      Match.exhaustive,
    );
  }).pipe(
    Effect.catchTags({
      TaskNotFound: (e) => Effect.logWarning(`worker exit for unknown task ${e.taskId}`),
      RepoError: (e) => Effect.logError(`repo error in ${e.op}: ${String(e.cause)}`),
    }),
  );
  return Effect.runPromise(program);
}
