// Worker execution backends. The dispatcher talks only to this interface, so
// the local `claude -p` launcher and a future Claude Code Web backend are
// swappable without touching the dispatcher, board, or UI. Both report
// back through the same self-describing worker API (curl), so nothing
// downstream knows or cares which backend ran the task.

import { existsSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { WORKER_CMD } from "./config.ts";

export interface LaunchSpec {
  taskId: string;
  sessionId: string;
  title: string;
  objective: string;
  repoPath: string; // local repo for the task's workspace
  baseRef: string; // branch/commit to fork the worktree from
  branch: string; // pm/<taskId>
  worktreePath: string; // sibling dir outside the repo
  bootstrapUrl: string; // curl target the worker is handed
  token: string;
  strategies?: string[];
  resume?: boolean; // true when re-attaching after a restart
  // Workspace context — everything the worker needs to land ready-to-work.
  subpath?: string; // work inside this subdir of the repo
  secrets?: Record<string, string>; // injected as env vars
  envFiles?: string[]; // sourced before the agent runs
  setup?: string; // shell run once when the worktree is created
}

export interface WorkerHandle {
  sessionId: string;
  pid?: number;
  logPath: string;
  kind: string;
  // Resolves when the worker process exits (local backend only). Lets the
  // dispatcher track liveness accurately rather than polling.
  exited?: Promise<number>;
}

export interface WorkerBackend {
  readonly kind: string;
  launch(spec: LaunchSpec): Promise<WorkerHandle>;
}

async function sh(args: string[], cwd?: string): Promise<{ ok: boolean; out: string }> {
  const p = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { ok: code === 0, out: out + err };
}

// Create (or reuse) the task's git worktree on its branch. On first creation,
// run the Workspace's setup shell so the worker lands in a prepared environment.
async function ensureWorktree(spec: LaunchSpec): Promise<void> {
  if (existsSync(spec.worktreePath)) return; // already checked out (resume)
  mkdirSync(dirname(spec.worktreePath), { recursive: true });
  const branchExists = (
    await sh(["git", "-C", spec.repoPath, "rev-parse", "--verify", "--quiet", spec.branch])
  ).ok;
  const args = branchExists
    ? ["git", "-C", spec.repoPath, "worktree", "add", spec.worktreePath, spec.branch]
    : [
        "git",
        "-C",
        spec.repoPath,
        "worktree",
        "add",
        "-b",
        spec.branch,
        spec.worktreePath,
        spec.baseRef,
      ];
  const r = await sh(args);
  if (!r.ok) throw new Error(`git worktree add failed: ${r.out}`);
  if (spec.setup?.trim()) {
    const cwd = workCwd(spec);
    const s = await sh(["bash", "-lc", `cd ${JSON.stringify(cwd)} && ${spec.setup}`]);
    if (!s.ok) throw new Error(`workspace setup failed: ${s.out.slice(0, 300)}`);
  }
}

// The directory the agent actually works in: the worktree, narrowed to the
// Workspace's subpath when set (so monorepo Workspaces scope to their area).
function workCwd(spec: LaunchSpec): string {
  return spec.subpath ? join(spec.worktreePath, spec.subpath) : spec.worktreePath;
}

// `set -a; source <file>; set +a` for each env file, run before the agent.
function sourceEnvFiles(envFiles?: string[]): string {
  if (!envFiles?.length) return "";
  return envFiles.map((f) => `set -a; source ${JSON.stringify(f)}; set +a; `).join("");
}

// First-run prompt: full task context + how to discover the API.
function workerPrompt(spec: LaunchSpec): string {
  const strat = spec.strategies?.length
    ? `\nStrategies to follow:\n${spec.strategies.map((s) => `- ${s}`).join("\n")}\n`
    : "";
  return [
    `You are a PowderMonkey worker. You are on a dedicated git branch (${spec.branch}) in an isolated worktree. Do not touch other branches.`,
    ``,
    `Task: ${spec.title}`,
    `Objective: ${spec.objective}`,
    strat,
    `To get your task details and EVERY action you can take (claim, progress, question, artifact, review), run:`,
    `  curl -s ${spec.bootstrapUrl}`,
    `That endpoint describes itself — it returns ready-to-paste curl commands. Report status by curling it when something meaningful happens; do not poll in a loop.`,
    ``,
    `Workflow: POST a claim first, do the work and commit it on this branch, then POST a pull_request artifact (ref=${spec.branch}) and request review.`,
    `If you are blocked on a decision only the operator can make, POST a question and then STOP and end your run — you will be automatically resumed with the operator's answer. Do not poll.`,
  ].join("\n");
}

// Resume message (delivered via `claude --continue`, so the session already has
// the full prior context — keep it short).
function resumeMessage(spec: LaunchSpec): string {
  return [
    `The operator has responded on your task. Run:`,
    `  curl -s ${spec.bootstrapUrl}/inbox`,
    `to read their latest answer/comment, then continue and finish the objective.`,
    `When done, commit on ${spec.branch}, POST a pull_request artifact (ref=${spec.branch}), and request review.`,
  ].join("\n");
}

// Local backend: spawn `claude -p` in the task's worktree, autonomous.
export class LocalClaudeBackend implements WorkerBackend {
  readonly kind = "local-claude";

  async launch(spec: LaunchSpec): Promise<WorkerHandle> {
    await ensureWorktree(spec);
    // Fresh run gets the full prompt; a resume uses `claude --continue` so the
    // prior session context is intact and only a short nudge is needed.
    const prompt = spec.resume ? resumeMessage(spec) : workerPrompt(spec);
    const logPath = `${spec.worktreePath}.log`;
    const fd = openSync(logPath, "a");

    // We run `claude` through a LOGIN shell (`bash -lc`) on purpose: a bare
    // spawn of `claude` crashes (it relies on environment the user's profile
    // sets up), whereas the same command via the login shell works. The prompt
    // is passed via $PM_PROMPT to dodge all quoting/newline issues.
    // PM_WORKER_CMD lets tests substitute a fake worker script instead.
    const cwd = workCwd(spec); // worktree, narrowed to the Workspace subpath
    const override = WORKER_CMD;
    const claude = spec.resume
      ? 'claude -p --continue "$PM_PROMPT" --dangerously-skip-permissions'
      : 'claude -p "$PM_PROMPT" --dangerously-skip-permissions';
    // Source the Workspace's env files, then exec the agent in the work dir.
    const inner = `cd "$PM_CWD" && ${sourceEnvFiles(spec.envFiles)}exec ${claude}`;
    const argv = override ? [override] : ["bash", "-lc", inner];

    const proc = Bun.spawn(argv, {
      cwd,
      stdout: fd,
      stderr: fd,
      env: {
        ...process.env,
        ...(spec.secrets ?? {}), // Workspace secrets injected as env vars
        PM_BOOTSTRAP_URL: spec.bootstrapUrl,
        PM_TOKEN: spec.token,
        PM_BRANCH: spec.branch,
        PM_WORKTREE: spec.worktreePath,
        PM_CWD: cwd,
        PM_PROMPT: prompt,
      },
    });

    return {
      sessionId: spec.sessionId,
      pid: proc.pid,
      logPath,
      kind: this.kind,
      exited: proc.exited,
    };
  }
}

// Selected by env; only the local backend exists today.
export function makeBackend(): WorkerBackend {
  // Future: if (process.env.PM_BACKEND === "claude-web") return new ClaudeWebBackend();
  return new LocalClaudeBackend();
}
