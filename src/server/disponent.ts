import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  Disponent,
  type Session as DSession,
  SessionState as DState,
  setEnv,
} from "@disponent/node";
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

/** SessionState value → name, for readable "never came up" errors. */
export const STATE_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(DState).map(([name, value]) => [value as number, name]),
);

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
