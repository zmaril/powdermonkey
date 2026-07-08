import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  CapabilityKind,
  type DispatchSpec,
  Disponent,
  type Session as DSession,
  SessionState as DState,
  setEnv,
} from "@disponent/node";
import type { EnvCapability } from "../shared/types.ts";
import { supervisorRepoDir } from "./repo-cache.ts";
import { type ExeDevConfig, getExeDevConfig } from "./settings.ts";

// The shared disponent engine (github.com/zmaril/disponent). Both dispatch
// backends that lean on disponent — the exe.dev worker VMs (exe-dev.ts) and the
// on-laptop tmux worktree sessions (local-disponent.ts) — drive ONE engine
// instance so they share a single ledger + sink and one reconcile pass adopts
// whatever a previous supervisor left behind, local or remote.
//
// Backend knobs ride env vars read once at open. They go through `setEnv`, NOT
// process.env: under Bun a JS-side env write updates only the JS snapshot — the
// native Rust engine reading `std::env::var` never sees it (the hard way we
// learned this was a "dry-run" test provisioning real VMs).
//
// Test seams (no user config): PM_EXE_DRY_RUN → DISPONENT_EXE_DRY_RUN fabricates
// every VM op; PM_LOCAL_DRY_RUN → DISPONENT_LOCAL_DRY_RUN fabricates every local
// tmux op. Either keeps the ledger in memory (sink "none") so nothing spawns.

let engine: Disponent | null = null;

/** The disponent engine, opened lazily. Call `resetDisponent()` after changing
 *  exe.dev settings so the next use reopens with the new values. */
export function getDisponent(cfg: ExeDevConfig = getExeDevConfig()): Disponent {
  if (!engine) {
    setEnv("DISPONENT_CLAUDE_FLAGS", cfg.claudeFlags);
    setEnv("DISPONENT_EXE_TTYD_PORT", String(cfg.ttydPort));
    // Opt-in, honest edge: only when the operator points us at an OTel port does
    // disponent's receiver emit real Usage events for the per-backend meters. Left
    // unset, the meters read a truthful 0 rather than faking a number. Additive —
    // it changes nothing about provisioning or the progress invariant.
    if (process.env.PM_DISPONENT_OTEL_PORT) {
      setEnv("DISPONENT_OTEL_PORT", process.env.PM_DISPONENT_OTEL_PORT);
    }
    const exeDry = Boolean(process.env.PM_EXE_DRY_RUN);
    const localDry = Boolean(process.env.PM_LOCAL_DRY_RUN);
    if (exeDry) setEnv("DISPONENT_EXE_DRY_RUN", "1");
    if (localDry) setEnv("DISPONENT_LOCAL_DRY_RUN", "1");
    let sink = "none";
    if (!exeDry && !localDry) {
      const dataDir = join(supervisorRepoDir(), "data");
      mkdirSync(dataDir, { recursive: true });
      sink = join(dataDir, "disponent.sqlite3");
    }
    engine = new Disponent({ sink });
  }
  return engine;
}

/** Drop the engine so the next use reopens (settings changed, tests). */
export function resetDisponent(): void {
  engine = null;
}

// disponent hands capabilities back as the numeric `CapabilityKind` enum (its
// napi members aren't enumerable, so we can't reflect a reverse map). Key the
// name map off the *named* members instead of literal integers, so it stays
// correct if disponent ever renumbers the enum — only a renamed/removed member
// would need a matching edit here. An unknown kind (a disponent that advertises
// something this pin doesn't know) falls through to its raw code rather than
// being hidden or faked — honest capability edge.
const CAPABILITY_NAME: Record<number, string> = {
  [CapabilityKind.Dispatch]: "dispatch",
  [CapabilityKind.Interact]: "interact",
  [CapabilityKind.ObserveStream]: "observe_stream",
  [CapabilityKind.ObservePoll]: "observe_poll",
  [CapabilityKind.ListSessions]: "list_sessions",
  [CapabilityKind.Resume]: "resume",
  [CapabilityKind.Cancel]: "cancel",
  [CapabilityKind.Teardown]: "teardown",
  [CapabilityKind.IsolationWorktree]: "isolation_worktree",
  [CapabilityKind.IsolationContainer]: "isolation_container",
  [CapabilityKind.IsolationVm]: "isolation_vm",
  [CapabilityKind.Templates]: "templates",
  [CapabilityKind.ArtifactFetch]: "artifact_fetch",
  [CapabilityKind.UsageReport]: "usage_report",
};

/** pm's per-env capability registry — what each environment disponent knows can
 *  do (its env_capabilities edge), read live from the engine. Parallels
 *  `offerings()`: the numeric `CapabilityKind` is lowered to disponent's
 *  snake_case token so the wire (and the UI) speaks readable names. The Settings
 *  dispatch picker shows these per backend so the operator sees what each
 *  environment can actually do. */
export async function capabilities(): Promise<EnvCapability[]> {
  const rows = await getDisponent().capabilities();
  return rows.map((r) => ({
    envSlug: r.envSlug,
    capability: CAPABILITY_NAME[r.capability] ?? String(r.capability),
    ...(r.detail != null ? { detail: r.detail } : {}),
  }));
}

/** SessionState value → name, for readable "never came up" errors. */
export const STATE_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(DState).map(([name, value]) => [value as number, name]),
);

/** Dispatch one worker for a pm task, turning a thrown engine error into the
 *  `{ok:false}` failure report both backends surface. It stamps the identifying
 *  `title` / `labels` both backends share (`pm-task-<id>` + `{pmTask:id}`), so the
 *  caller only supplies the backend-specific spec (exe.dev: env/repo/template/…;
 *  local: env "local"/isolation/gitRef/repo/…). On success the started session
 *  rides back on `.session`. */
export async function tryDispatch(
  d: Disponent,
  taskId: number,
  spec: Omit<DispatchSpec, "title" | "labels">,
): Promise<{ ok: true; session: DSession } | { ok: false; error: string }> {
  try {
    const session = await d.dispatch({
      ...spec,
      title: `pm-task-${taskId}`,
      labels: JSON.stringify({ pmTask: taskId }),
    });
    return { ok: true, session };
  } catch (e) {
    return { ok: false, error: `disponent dispatch: ${e instanceof Error ? e.message : e}` };
  }
}

/** Poll until the session leaves queued/provisioning (disponent provisions on a
 *  background thread; its `wait()` waits for *terminal*, which a healthy worker
 *  never reaches — running is the success here). Shared by both backends. */
export async function waitForRunning(
  d: Disponent,
  uid: string,
  timeoutMs: number,
): Promise<DSession> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = await d.session(uid);
    if (!s) throw new Error(`disponent lost session ${uid}`);
    const settling = s.state === DState.Queued || s.state === DState.Provisioning;
    if (!settling || Date.now() >= deadline) return s;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** The shared provisioning spine of both backends: dispatch a worker (`tryDispatch`),
 *  wait until it settles (`waitForRunning`), and confirm it actually came up —
 *  Running, with an env handle, plus whatever `ready` additionally demands (exe.dev
 *  also needs its ttyd `url`). Returns the settled session, or the `{ok:false}`
 *  report — a dispatch throw, or a "<label> never came up (<state>)" — that each
 *  provisioner surfaces verbatim. The caller reads its backend-specific fields
 *  (vmName/url, or workDir/handle) off the returned session. */
export async function dispatchAndAwaitRunning(
  d: Disponent,
  taskId: number,
  spec: Omit<DispatchSpec, "title" | "labels">,
  opts: { timeoutMs: number; label: string; ready?: (s: DSession) => boolean },
): Promise<{ ok: true; session: DSession } | { ok: false; error: string; output?: string }> {
  const disp = await tryDispatch(d, taskId, spec);
  if (!disp.ok) return disp;
  const settled = await waitForRunning(d, disp.session.uid, opts.timeoutMs);
  const up =
    settled.state === DState.Running &&
    settled.envHandle != null &&
    (opts.ready?.(settled) ?? true);
  if (!up) {
    return {
      ok: false,
      error: `${opts.label} never came up (${STATE_NAMES[settled.state] ?? settled.state})`,
      output: settled.exitDetail ?? undefined,
    };
  }
  return { ok: true, session: settled };
}
