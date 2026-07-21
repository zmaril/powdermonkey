import { AttachTransport, IsolationKind } from "@disponent/node";
import { dispatchAndAwaitRunning, getDisponent } from "./disponent.ts";

// NB: no node:path import — the holder socket path is now read from disponent's
// descriptor (attachEndpoint), not reconstructed from a path convention.

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
  /** Teleport only: fetch `branch` from the clone's `origin` and cut the worktree
   *  off it (prefer local `<branch>`, else `origin/<branch>`, else HEAD), rather
   *  than off local HEAD. A plain start-local leaves this false. */
  fetchRemote?: boolean;
  /** Teleport only: a bespoke startup command run VERBATIM in the session tmux with
   *  NO brief appended (e.g. `claude --teleport <id>`, to resume the cloud run's
   *  conversation). A plain start-local leaves this undefined, so disponent runs its
   *  default `claude … "$(cat brief.md)"`. */
  startup?: string;
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

/** Whether pm should select the disponent holder path at PROVISION time: run local
 *  agents under `disponent hold` (via DISPONENT_LOCAL_HOLDER, set on the engine in
 *  disponent.ts) rather than a bare tmux session. Off by default — set PM_LOCAL_HOLDER
 *  to any non-empty value to opt in. The ATTACH side is no longer gated on this flag:
 *  pm reads disponent's transport-neutral descriptor (below) and attaches to whatever
 *  transport the running session actually reports (tmux or dsp-hold). */
export function holderEnabled(): boolean {
  return Boolean(process.env.PM_LOCAL_HOLDER);
}

/** Where + how pm's browser terminal reaches a disponent-local session's live
 *  terminal, resolved from disponent #78's transport-neutral attach descriptor on the
 *  Session — pm switches on `transport` instead of assuming tmux (or guessing a holder
 *  socket path). `tmux` → attach `tmux -L <socket> -t <session>`; `dsp_hold` → dial the
 *  holder unix socket (holder-client.ts); `ttyd` → a web-only address pm's shell
 *  terminal can't attach to. */
export type DisponentAttach =
  | { transport: "tmux"; socket: string; tmuxSession: string }
  | { transport: "dsp_hold"; socketPath: string }
  | { transport: "ttyd"; url: string };

/** Resolve the attach descriptor for a disponent-local session (engine uid, parked in
 *  a pm session's `vmName`) from disponent's TYPED Session fields
 *  (`attachTransport`/`attachEndpoint`/`attachTarget`/`attachUrl`, #78). Returns null
 *  when the session is gone or reports no reachable terminal (all descriptor fields
 *  null) — honest rather than faked. A first miss reconciles once, since a reopened
 *  engine (post supervisor restart) may not yet know a prior uid. */
export async function resolveDisponentAttach(uid: string): Promise<DisponentAttach | null> {
  const d = getDisponent();
  let session = await d.session(uid);
  if (!session) {
    try {
      await d.reconcile();
    } catch {}
    session = await d.session(uid);
  }
  if (!session) return null;
  const { attachTransport, attachEndpoint, attachTarget, attachUrl } = session;
  switch (attachTransport) {
    case AttachTransport.Tmux:
      // tmux → endpoint = socket, target = session name (`dsp-<uid>`).
      return attachEndpoint && attachTarget
        ? { transport: "tmux", socket: attachEndpoint, tmuxSession: attachTarget }
        : null;
    case AttachTransport.DspHold:
      // dsp-hold → endpoint = the holder's unix socket path.
      return attachEndpoint ? { transport: "dsp_hold", socketPath: attachEndpoint } : null;
    case AttachTransport.Ttyd:
      return attachUrl ? { transport: "ttyd", url: attachUrl } : null;
    default:
      return null;
  }
}

/** Provision a local worktree session for a task and start its agent in tmux —
 *  one disponent dispatch against the `local` env with worktree isolation.
 *  Returns the engine session uid (for teardown) and the local handle (tmux name
 *  + socket + work dir), or the engine's failure report. */
export async function provisionLocalWorker(
  args: LocalProvisionArgs,
): Promise<LocalProvisionResult> {
  const { taskId, repoDir, branch, brief, fetchRemote, startup } = args;
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
      // Teleport rides these two (undefined/false for a plain start-local, so the
      // spec is byte-identical to today's): fetch `branch` off the clone's origin
      // (#74), and run `startup` verbatim as the agent command with no brief (#33).
      fetchRemote,
      agentCmd: startup,
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
