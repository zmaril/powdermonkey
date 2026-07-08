import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Disponent,
  type Session as DSession,
  SessionState as DState,
  setEnv,
} from "@disponent/node";
import { and, isNotNull, isNull } from "drizzle-orm";
import { SessionKind } from "../shared/types.ts";
import { db } from "./db.ts";
import { supervisorRepoDir } from "./repo-cache.ts";
import { sessions } from "./schema.ts";
import { type ExeDevConfig, getExeDevConfig } from "./settings.ts";

// The exe.dev cloud-dispatch backend — now a thin adapter over disponent
// (github.com/zmaril/disponent), the engine that owns worker provisioning,
// observation, reconcile-adoption, and teardown. PowderMonkey hands it a
// brief + repo slug + template VM name; disponent copies the template, clones
// the repo, starts the agent in tmux behind a ttyd URL, and remembers the
// session in its own ledger. What PowderMonkey keeps is its own tracking row
// (SessionKind.Remote + vmName) — progress still reads off main's trailers,
// agent- and engine-agnostic.
//
// Test seam: PM_EXE_DRY_RUN maps onto disponent's dry-run backend
// (DISPONENT_EXE_DRY_RUN) — every VM operation is fabricated, nothing spawns.

/** How long a real provision may take before we call it failed (template copy
 *  + VM boot + clone). The dry-run backend settles in milliseconds. */
const PROVISION_TIMEOUT_MS = 300_000;

/** Orphaned-worker grace: a just-provisioned VM whose pm session row isn't
 *  written yet must never be swept. */
const GC_GRACE_MS = Number(process.env.PM_EXE_GC_GRACE_MS ?? 5 * 60_000);

let engine: Disponent | null = null;

/** The disponent engine, opened lazily. Backend knobs (claude flags, ttyd
 *  port) ride env vars read once at open — mirrored from Settings here; call
 *  `resetDisponent()` after changing exe.dev settings so the next use reopens
 *  with the new values. Dry-run tests keep the ledger in memory. */
export function getDisponent(cfg: ExeDevConfig = getExeDevConfig()): Disponent {
  if (!engine) {
    // setEnv, not process.env: under Bun, JS-side env writes never reach the
    // native engine (they configure nothing — the hard way we learned this
    // was a "dry-run" test provisioning real VMs).
    setEnv("DISPONENT_CLAUDE_FLAGS", cfg.claudeFlags);
    setEnv("DISPONENT_EXE_TTYD_PORT", String(cfg.ttydPort));
    // Opt-in, honest edge: only when the operator points us at an OTel port does
    // disponent's receiver emit real Usage events for the per-backend meters. Left
    // unset, the meters read a truthful 0 rather than faking a number. Additive —
    // it changes nothing about provisioning or the progress invariant.
    if (process.env.PM_DISPONENT_OTEL_PORT) {
      setEnv("DISPONENT_OTEL_PORT", process.env.PM_DISPONENT_OTEL_PORT);
    }
    let sink = "none";
    if (process.env.PM_EXE_DRY_RUN) {
      setEnv("DISPONENT_EXE_DRY_RUN", "1");
    } else {
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

const STATE_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(DState).map(([name, value]) => [value as number, name]),
);

/** Poll until the session leaves queued/provisioning (disponent provisions on
 *  a background thread; its `wait()` waits for *terminal*, which a healthy
 *  worker never reaches — running is the success here). */
async function waitForRunning(d: Disponent, uid: string, timeoutMs: number): Promise<DSession> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = await d.session(uid);
    if (!s) throw new Error(`disponent lost session ${uid}`);
    const settling = s.state === DState.Queued || s.state === DState.Provisioning;
    if (!settling || Date.now() >= deadline) return s;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** The disponent session backing a worker VM, if the engine knows one. A
 *  reconcile() first adopts anything a previous supervisor left behind, so a
 *  restart doesn't strand teardown. */
export async function sessionForVm(d: Disponent, vmName: string): Promise<DSession | null> {
  const find = async () => {
    const all = await d.sessions();
    return (
      all.find((s) => {
        try {
          return s.envHandle != null && JSON.parse(s.envHandle).vmName === vmName;
        } catch {
          return false;
        }
      }) ?? null
    );
  };
  return (await find()) ?? (await d.reconcile().then(find));
}

export type ProvisionResult =
  | { ok: true; vmName: string; url: string }
  | { ok: false; error: string; output?: string };

export type CmdResult = { ok: boolean; output: string };

export type ProvisionArgs = {
  slug: string;
  taskId: number;
  promptPath: string;
  cfg: ExeDevConfig;
};

/** Provision a worker VM for a task and start its claude session — one
 *  disponent dispatch. Returns the VM name (for teardown) and the ttyd
 *  session URL, or the engine's failure report. */
export async function provisionWorker(args: ProvisionArgs): Promise<ProvisionResult> {
  const { slug, taskId, promptPath, cfg } = args;
  const d = getDisponent(cfg);
  const brief = readFileSync(promptPath, "utf8");

  let dispatched: DSession;
  try {
    dispatched = await d.dispatch({
      brief,
      env: "exe-dev", // lint-allow-string: disponent's environment slug, not pm's DispatchBackend
      repo: slug,
      template: cfg.template,
      title: `pm-task-${taskId}`,
      labels: JSON.stringify({ pmTask: taskId }),
    });
  } catch (e) {
    return { ok: false, error: `disponent dispatch: ${e instanceof Error ? e.message : e}` };
  }

  const settled = await waitForRunning(d, dispatched.uid, PROVISION_TIMEOUT_MS);
  if (settled.state !== DState.Running || !settled.envHandle || !settled.url) {
    return {
      ok: false,
      error: `worker never came up (${STATE_NAMES[settled.state] ?? settled.state})`,
      output: settled.exitDetail ?? undefined,
    };
  }
  return { ok: true, vmName: JSON.parse(settled.envHandle).vmName, url: settled.url };
}

/** Delete a worker VM (disponent reap: resources torn down, ledger archived). */
export async function teardownWorker(vmName: string): Promise<CmdResult> {
  const d = getDisponent();
  const session = await sessionForVm(d, vmName);
  if (!session) return { ok: false, output: `disponent knows no worker ${vmName}` };
  if (session.reapedAt) return { ok: true, output: `already reaped ${vmName}` };
  try {
    await d.reap(session.uid);
    return { ok: true, output: `reaped ${vmName}` };
  } catch (e) {
    return { ok: false, output: e instanceof Error ? e.message : String(e) };
  }
}

/** Tear down the exe.dev worker backing a session, if any. A no-op unless the
 *  session is a remote exe.dev run (has a `vmName`) and auto-teardown is
 *  enabled; a failed reap is logged, never thrown — teardown must not block a
 *  land/stop/reconcile. */
export async function teardownRemoteWorker(session: {
  kind: SessionKind;
  vmName: string | null;
}): Promise<void> {
  if (session.kind !== SessionKind.Remote || !session.vmName) return;
  if (!getExeDevConfig().autoTeardown) return;
  const r = await teardownWorker(session.vmName);
  if (!r.ok) console.warn(`exe-dev: teardown ${session.vmName} (non-fatal): ${r.output}`);
}

/** Garbage-collect leaked worker VMs: disponent adopts anything tagged that
 *  it doesn't know (a crashed supervisor's workers), then any running worker
 *  no live pm session references — and older than the grace window — is
 *  reaped. No-op when auto-teardown is off or this supervisor has never
 *  provisioned a worker (so a pure claude-remote/local user never touches the
 *  engine). Returns the number removed. */
export async function gcOrphanedWorkers(nowMs: number = Date.now()): Promise<number> {
  if (!getExeDevConfig().autoTeardown) return 0;
  const [ever] = await db
    .select({ vmName: sessions.vmName })
    .from(sessions)
    .where(isNotNull(sessions.vmName))
    .limit(1);
  if (!ever) return 0;

  const d = getDisponent();
  await d.reconcile();
  const running = await d.sessions({ state: DState.Running });
  if (running.length === 0) return 0;

  const rows = await db
    .select({ vmName: sessions.vmName })
    .from(sessions)
    .where(and(isNull(sessions.archivedAt), isNotNull(sessions.vmName)));
  const live = new Set(rows.map((r) => r.vmName).filter((n): n is string => n != null));

  let removed = 0;
  for (const s of running) {
    let vmName: string | null = null;
    try {
      vmName = s.envHandle ? JSON.parse(s.envHandle).vmName : null;
    } catch {
      /* not an exe.dev handle */
    }
    if (!vmName || live.has(vmName)) continue;
    const bornMs = s.startedAt ? Date.parse(s.startedAt) : 0;
    if (nowMs - bornMs <= GC_GRACE_MS) continue;
    try {
      await d.reap(s.uid);
      removed++;
    } catch (e) {
      console.warn(`exe-dev: gc reap ${vmName} (non-fatal): ${e}`);
    }
  }
  if (removed > 0) console.log(`exe-dev: garbage-collected ${removed} orphaned worker VM(s)`);
  return removed;
}
