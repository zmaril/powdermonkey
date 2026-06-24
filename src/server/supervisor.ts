// The Supervisor: turns a Goal into a reviewable Plan, written in Effect. It runs
// a `claude -p` planning pass in an isolated worktree of the workspace's repo (so it
// can read the code but can't touch the real working tree), captures a JSON plan,
// and appends a `plan_proposed` action with the proposed tasks. Pure helpers
// (prompt, parse) stay pure; all IO and failure modes are typed Effects.

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import type { ProposedTask } from "../shared/types.ts";
import { SUPERVISOR_CMD, WORKTREE_ROOT } from "./config.ts";
import { Invalid, NotFound, ParseError } from "./fx/errors.ts";
import { run } from "./fx/proc.ts";
import * as Repo from "./repo.ts";

interface ParsedPlan {
  title: string;
  summary: string;
  tasks: ProposedTask[];
}

function planningPrompt(goalTitle: string, goalIntent: string | undefined): string {
  return [
    `You are the PowderMonkey supervisor. Analyze THIS repository (the working directory) and propose a concrete, bounded plan to achieve the goal below.`,
    ``,
    `Goal: ${goalTitle}`,
    goalIntent ? `Intent: ${goalIntent}` : ``,
    ``,
    `Read the code as needed to ground the plan, but DO NOT modify any files.`,
    `Break the goal into a small number (2–6) of independent, parallelizable tasks. Each task must be bounded and have a clear objective a single worker can complete on its own branch. Prefer small, low-conflict tasks.`,
    ``,
    `Output ONLY a JSON object, no prose, with this exact shape:`,
    `{"title": string, "summary": string, "tasks": [{"title": string, "objective": string, "kind": "implementation"|"investigation"|"planning"|"review"}]}`,
  ]
    .filter(Boolean)
    .join("\n");
}

// Robustly pull a {title,summary,tasks} object out of supervisor stdout (raw
// JSON, a ```json fence, or a `claude -p --output-format json` envelope). Pure;
// throws on failure (wrapped in Effect.try by the caller).
function extractPlan(raw: string): ParsedPlan {
  const tryParse = (s: string): unknown => {
    const trimmed = s
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/, "");
    try {
      return JSON.parse(trimmed);
    } catch {
      const m = trimmed.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          return JSON.parse(m[0]);
        } catch {
          /* fallthrough */
        }
      }
      return null;
    }
  };
  const isPlan = (o: unknown): o is ParsedPlan =>
    !!o && typeof o === "object" && Array.isArray((o as ParsedPlan).tasks);

  const top = tryParse(raw);
  if (isPlan(top)) return top;
  if (top && typeof (top as { result?: unknown }).result === "string") {
    const inner = tryParse((top as { result: string }).result);
    if (isPlan(inner)) return inner;
  }
  throw new Error("could not parse a plan from supervisor output");
}

const sh = (args: string[]) =>
  run(args).pipe(Effect.map((r) => ({ ok: r.ok, out: `${r.out}${r.err}` })));

const ensurePlanWorktree = (repoPath: string, worktreePath: string, branch: string) =>
  Effect.gen(function* () {
    if (existsSync(worktreePath)) return;
    yield* Effect.sync(() => mkdirSync(dirname(worktreePath), { recursive: true }));
    const head =
      (yield* sh(["git", "-C", repoPath, "rev-parse", "--abbrev-ref", "HEAD"])).out.trim() ||
      "HEAD";
    const exists = (yield* sh(["git", "-C", repoPath, "rev-parse", "--verify", "--quiet", branch]))
      .ok;
    const r = exists
      ? yield* sh(["git", "-C", repoPath, "worktree", "add", worktreePath, branch])
      : yield* sh(["git", "-C", repoPath, "worktree", "add", "-b", branch, worktreePath, head]);
    if (!r.ok) {
      return yield* Effect.fail(new Invalid({ reason: `planning worktree failed: ${r.out}` }));
    }
  });

const getGoalOr = (id: string) =>
  Repo.getGoal(id).pipe(
    Effect.flatMap((g) =>
      g ? Effect.succeed(g) : Effect.fail(new NotFound({ what: "goal", id })),
    ),
  );

const workspaceOr = (projectId: string) =>
  Repo.getWorkspace(projectId).pipe(
    Effect.flatMap((p) =>
      p?.repoPath
        ? Effect.succeed(p as NonNullable<typeof p> & { repoPath: string })
        : Effect.fail(new Invalid({ reason: "goal's workspace has no repoPath" })),
    ),
  );

export interface ProposeResult {
  ok: boolean;
  planId?: string;
  taskCount?: number;
  error?: string;
}

const proposePlanFx = (goalId: string) =>
  Effect.gen(function* () {
    const goal = yield* getGoalOr(goalId);
    const workspace = yield* workspaceOr(goal.workspaceId);

    const branch = `pm-plan/${goalId}`;
    const worktreePath = `${WORKTREE_ROOT}/${workspace.id}/plan-${goalId}`;
    yield* ensurePlanWorktree(workspace.repoPath, worktreePath, branch);

    const prompt = planningPrompt(goal.title, goal.intent ?? undefined);
    const cwd = workspace.subpath ? join(worktreePath, workspace.subpath) : worktreePath;
    const sourceEnv = (workspace.envFiles ?? [])
      .map((f) => `set -a; source ${JSON.stringify(f)}; set +a; `)
      .join("");
    const argv = SUPERVISOR_CMD
      ? [SUPERVISOR_CMD]
      : [
          "bash",
          "-lc",
          `cd "$PM_CWD" && ${sourceEnv}exec claude -p "$PM_PROMPT" --output-format json`,
        ];

    const res = yield* run(argv, {
      cwd,
      env: {
        ...process.env,
        ...(workspace.secrets ?? {}),
        PM_WORKTREE: worktreePath,
        PM_CWD: cwd,
        PM_PROMPT: prompt,
      },
    });
    if (res.code !== 0) {
      return yield* Effect.fail(
        new Invalid({ reason: `supervisor exited ${res.code}: ${res.err.slice(0, 200)}` }),
      );
    }

    const plan = yield* Effect.try({
      try: () => extractPlan(res.out),
      catch: (cause) => new ParseError({ what: "plan", cause, sample: res.out.slice(0, 200) }),
    });

    const planId = `plan-${goalId}-${Math.random().toString(36).slice(2, 7)}`;
    const tasks: ProposedTask[] = (plan.tasks ?? []).map((t) => ({
      title: String(t.title ?? "task"),
      objective: String(t.objective ?? ""),
      kind: (["implementation", "investigation", "planning", "review"].includes(t.kind)
        ? t.kind
        : "implementation") as ProposedTask["kind"],
    }));
    yield* Repo.createPlan(
      {
        id: planId,
        goalId,
        title: plan.title ?? goal.title,
        summary: plan.summary ?? "",
        status: "proposed",
        proposedTasks: tasks,
      },
      { actor: "supervisor", action: "plan_proposed", summary: plan.title ?? goal.title },
    );
    return { ok: true, planId, taskCount: tasks.length };
  });

export const proposePlan = (goalId: string): Promise<ProposeResult> =>
  Effect.runPromise(
    proposePlanFx(goalId).pipe(
      Effect.catchTags({
        NotFound: () => Effect.succeed({ ok: false, error: "unknown goal" } as ProposeResult),
        Invalid: (e) => Effect.succeed({ ok: false, error: e.reason } as ProposeResult),
        RepoError: (e) =>
          Effect.succeed({ ok: false, error: `db error (${e.op})` } as ProposeResult),
        SpawnError: (e) => Effect.succeed({ ok: false, error: String(e.cause) } as ProposeResult),
        ParseError: (e) =>
          Effect.succeed({
            ok: false,
            error: `could not parse a plan; output head: ${e.sample}`,
          } as ProposeResult),
      }),
    ),
  );
