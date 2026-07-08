import { readFileSync } from "node:fs";
import { type Disponent, type Session as DSession, SessionState as DState } from "@disponent/node";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { SessionKind } from "../shared/types.ts";
import { db } from "./db.ts";
import { dispatchAndAwaitRunning, getDisponent } from "./disponent.ts";
import { sessions } from "./schema.ts";
import { type ExeDevConfig, getExeDevConfig } from "./settings.ts";

// The exe.dev cloud-dispatch backend — a thin adapter over disponent
// (github.com/zmaril/disponent), the engine that owns worker provisioning,
// observation, reconcile-adoption, and teardown. PowderMonkey hands it a
// brief + repo slug + template VM name; disponent copies the template, clones
// the repo, starts the agent in tmux behind a ttyd URL, and remembers the
// session in its own ledger. What PowderMonkey keeps is its own tracking row
// (SessionKind.Remote + vmName) — progress still reads off main's trailers,
// agent- and engine-agnostic. The engine itself is opened in ./disponent.ts and
// shared with the local backend (local-disponent.ts).
//
// Test seam: PM_EXE_DRY_RUN maps onto disponent's dry-run backend
// (DISPONENT_EXE_DRY_RUN) — every VM operation is fabricated, nothing spawns.

// Re-exported for callers that reach the engine through this module (tests).
export { getDisponent, resetDisponent } from "./disponent.ts";

/** How long a real provision may take before we call it failed (template copy
 *  + VM boot + clone). The dry-run backend settles in milliseconds. */
const PROVISION_TIMEOUT_MS = 300_000;

/** Orphaned-worker grace: a just-provisioned VM whose pm session row isn't
 *  written yet must never be swept. */
const GC_GRACE_MS = Number(process.env.PM_EXE_GC_GRACE_MS ?? 5 * 60_000);

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

  const started = await dispatchAndAwaitRunning(
    d,
    taskId,
    {
      brief,
      env: "exe-dev", // lint-allow-string: disponent's environment slug, not pm's DispatchBackend
      repo: slug,
      template: cfg.template,
    },
    // exe.dev isn't up until its ttyd URL is published, too.
    { timeoutMs: PROVISION_TIMEOUT_MS, label: "worker", ready: (s) => s.url != null },
  );
  if (!started.ok) return started;
  const { session } = started;
  // Non-null by the readiness gate above (Running + envHandle + url).
  return {
    ok: true,
    vmName: JSON.parse(session.envHandle as string).vmName,
    url: session.url as string,
  };
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
  // Only exe.dev (remote) sessions carry a VM name here; a local-disponent
  // session reuses `vm_name` for its engine session uid, so scope this guard to
  // remote rows — a pure-local user must never touch the engine in GC.
  const [ever] = await db
    .select({ vmName: sessions.vmName })
    .from(sessions)
    .where(and(eq(sessions.kind, SessionKind.Remote), isNotNull(sessions.vmName)))
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
