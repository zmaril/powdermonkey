import { join } from "node:path";
import { IsolationKind } from "@disponent/node";
import { dispatchAndAwaitRunning, getDisponent } from "./disponent.ts";

// The local dispatch backend — a thin adapter over disponent's local tmux
// backend (github.com/zmaril/disponent). Where the exe.dev adapter (exe-dev.ts)
// hands the engine a repo slug + template and gets back a VM, this one hands it
// the ABSOLUTE PATH of pm's repo cache clone plus `isolation: "worktree"`, and
// the engine cuts a `git worktree` off that clone on a named branch, drops the
// brief in it, and runs the agent in a detached `tmux -L disponent` session.
// PowderMonkey keeps its own tracking row (SessionKind.Local + branch +
// worktree_path, with the engine session uid in vm_name for teardown); progress
// still reads off main's PM-Phase trailers, engine-agnostic.
//
// Lifecycle maps onto the engine: land → reap (removes the worktree, keeps the
// branch's committed work); stop → cancel (kills the tmux agent, leaves the
// worktree in place for inspection).
//
// Test seam: PM_LOCAL_DRY_RUN maps onto disponent's dry-run local backend
// (DISPONENT_LOCAL_DRY_RUN) — every git/tmux op is fabricated, nothing spawns.

/** How long a real provision may take before we call it failed (worktree add +
 *  setup + agent boot). The dry-run backend settles in milliseconds. */
const PROVISION_TIMEOUT_MS = 300_000;

/** The disponent local env handle (JSON on the session's envHandle): the tmux
 *  session name + socket the agent runs under, and the managed work dir (the
 *  worktree lives at `<workDir>/task`). */
export type LocalHandle = {
  tmux: string;
  socket: string;
  workDir: string;
  worktreeRepo?: string;
};

export type LocalProvisionArgs = {
  taskId: number;
  /** Absolute path of pm's repo cache clone — the worktree is cut off THIS
   *  local checkout (disponent's local worktree isolation needs a local repo). */
  repoDir: string;
  /** The worktree branch (`pm/task-<id>`); disponent selects it with `-B`. */
  branch: string;
  /** The built task prompt — disponent writes it as the worker's brief.md. */
  brief: string;
};

export type LocalProvisionResult =
  | { ok: true; uid: string; workDir: string; handle: LocalHandle }
  | { ok: false; error: string; output?: string };

// ── The holder attach path (M2b) ───────────────────────────────────────────────
//
// disponent's local backend has two ways to run a worker agent: the default tmux
// session, or — gated by DISPONENT_LOCAL_HOLDER — the first-party pty holder
// (`disponent hold`), which serves the agent's byte-exact pty over a unix socket.
// When the holder path is on, pm's browser terminal can dial that socket directly
// (holder-client.ts) instead of spawning a `tmux attach` PTY. tmux stays the
// DEFAULT; this pm-side flag only selects the alternative, and it's off unless set.

/** Whether pm should use the disponent holder path: run local agents under
 *  `disponent hold` (via DISPONENT_LOCAL_HOLDER, set on the engine in disponent.ts)
 *  AND attach the browser terminal to the holder socket rather than tmux. Off by
 *  default — set PM_LOCAL_HOLDER to any non-empty value to opt in. */
export function holderEnabled(): boolean {
  return Boolean(process.env.PM_LOCAL_HOLDER);
}

/** Where disponent's local backend places per-session holder sockets: `<root>/sock`,
 *  with `root` = DISPONENT_LOCAL_ROOT (default `$HOME/.disponent/work`) — the exact
 *  convention disponent computes internally (disponent-core `local.rs`: `holder_dir`
 *  is `self.root.join("sock")`, and `root` reads DISPONENT_LOCAL_ROOT). Both sides
 *  read the same real env var, so they agree on the path. */
function holderSocketDir(): string {
  const home = process.env.HOME ?? ".";
  const root = process.env.DISPONENT_LOCAL_ROOT ?? join(home, ".disponent", "work");
  return join(root, "sock");
}

/** The unix socket a holder-backed session's terminal is served on, derived from the
 *  engine session uid (parked in a pm session's `vmName`) + the socket-dir
 *  convention. Centralized here so it can later swap to a typed attach descriptor
 *  from disponent's schema (deferred) without touching the callers. */
export function resolveHolderAttachTarget(uid: string): string {
  return join(holderSocketDir(), `${uid}.sock`);
}

/** Provision a local worktree session for a task and start its agent in tmux —
 *  one disponent dispatch against the `local` env with worktree isolation.
 *  Returns the engine session uid (for teardown) and the local handle (tmux name
 *  + socket + work dir), or the engine's failure report. */
export async function provisionLocalWorker(
  args: LocalProvisionArgs,
): Promise<LocalProvisionResult> {
  const { taskId, repoDir, branch, brief } = args;
  const d = getDisponent();

  const started = await dispatchAndAwaitRunning(
    d,
    taskId,
    {
      brief,
      env: "local", // lint-allow-string: disponent's environment slug, not pm's SessionKind
      repo: repoDir,
      isolation: IsolationKind.Worktree,
      gitRef: branch,
    },
    { timeoutMs: PROVISION_TIMEOUT_MS, label: "local worker" },
  );
  if (!started.ok) return started;
  const { session } = started;
  // envHandle is non-null by the readiness gate in dispatchAndAwaitRunning.
  const handle = JSON.parse(session.envHandle as string) as LocalHandle;
  return { ok: true, uid: session.uid, workDir: handle.workDir, handle };
}

export type LocalCmdResult = { ok: boolean; output: string };

/** Reconcile-then-retry a teardown op on the engine: after a supervisor restart
 *  the reopened engine may not yet know a uid a previous run left behind, so a
 *  first miss adopts (reconcile) and tries once more. */
async function withReconcileRetry(
  op: (uid: string) => Promise<unknown>,
  uid: string,
  verb: string,
): Promise<LocalCmdResult> {
  const d = getDisponent();
  try {
    await op(uid);
    return { ok: true, output: `${verb} ${uid}` };
  } catch {
    try {
      await d.reconcile();
      await op(uid);
      return { ok: true, output: `${verb} ${uid}` };
    } catch (e) {
      return { ok: false, output: e instanceof Error ? e.message : String(e) };
    }
  }
}

/** Tear down a local worktree session (disponent reap: tmux agent killed, the
 *  worktree deregistered + removed; the branch's committed work is kept). */
export function teardownLocalWorker(uid: string): Promise<LocalCmdResult> {
  const d = getDisponent();
  return withReconcileRetry((u) => d.reap(u), uid, "reaped");
}

/** Abort a local worktree session (disponent cancel: tmux agent killed, the
 *  worktree left in place for inspection). */
export function cancelLocalWorker(uid: string): Promise<LocalCmdResult> {
  const d = getDisponent();
  // The "cancelled" below is a log verb, not a SessionState.
  return withReconcileRetry((u) => d.cancel(u), uid, "cancelled"); // lint-allow-string: log verb
}
