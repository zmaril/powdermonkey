// PowderMonkey supervisor — local Bun process on `main`, owns state, the only
// thing that talks to the cloud.

import { app } from "./app.ts";
import { startAutosync } from "./backup-sync.ts";
import { ready } from "./db.ts";
import { startGithubWatch } from "./github-watch.ts";
import { reconcile } from "./reconcile.ts";
import { seedSupervisorRepo } from "./seed.ts";
import { startSupervisorPty } from "./session-pty.ts";
import { loadSettings } from "./settings.ts";

const PORT = Number(process.env.PORT ?? 4500);

await ready();
// Load persisted operator settings (e.g. autoRebase) into the in-memory cache the
// watcher reads, so a toggle made before a restart is honored on boot.
await loadSettings();

// Upgrade path: make sure the supervisor's own repo is in the flat repo registry.
// Idempotent (find-or-create by slug), and non-fatal — a `gh` hiccup must never
// keep the supervisor from coming up.
try {
  await seedSupervisorRepo();
} catch (e) {
  console.warn("repo seed skipped:", e instanceof Error ? e.message : e);
}

// Bind the preferred port, but never crash if it's already taken — another
// instance (a teleported worker, or just a second copy) may already hold it.
// Elysia's .listen() silently swallows EADDRINUSE rather than throwing, so we
// detect availability ourselves: probe the port with a throwaway Bun.serve, and
// if it's busy hand Bun port 0 to get an OS-assigned free one. The actual port is
// always read back from app.server?.port, so PM_URL (which spawned shells inherit)
// and the browser's same-origin client follow along automatically.
function portAvailable(port: number): boolean {
  try {
    Bun.serve({ port, fetch: () => new Response() }).stop(true);
    return true;
  } catch (e) {
    if ((e as { code?: string }).code === "EADDRINUSE") return false;
    throw e;
  }
}

if (portAvailable(PORT)) {
  app.listen(PORT);
} else {
  console.warn(`port ${PORT} is in use — starting on an OS-assigned free port instead`);
  app.listen(0);
}

// Bring up the supervisor's own durable `claude` (in tmux, reserved id 0) so it's
// already running before the browser shell attaches — and so it persists across
// `--watch` restarts of this very process.
startSupervisorPty();

// Spawned shells (and the Claude sessions in them) inherit this, so the
// powdermonkey skill knows where the API is.
process.env.PM_URL = `http://localhost:${app.server?.port}`;

// Reconcile on a poll loop so the tree fills in as branches land on main. Guarded
// against overlap; a failed tick is logged, not fatal.
const RECONCILE_MS = Number(process.env.PM_RECONCILE_INTERVAL_MS ?? 15_000);
if (RECONCILE_MS > 0) {
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const r = await reconcile();
      if (r.phasesMarked > 0 || r.tasksCompleted > 0 || r.sessionsArchived > 0) {
        console.log(
          `reconciled: ${r.phasesMarked} phase(s), ${r.tasksCompleted} task(s), ` +
            `${r.sessionsArchived} session(s) archived`,
        );
      }
    } catch (e) {
      console.warn("reconcile tick failed:", e instanceof Error ? e.message : e);
    } finally {
      running = false;
    }
  }, RECONCILE_MS);
}

// Autosync: on every store write, produce a snapshot and land it on the durable
// backup branch (debounced/batched, off the write path). No-op until the operator
// turns it on (settings.syncMode); safe to start unconditionally.
startAutosync();

// Watch GitHub for cloud workers' PRs (pm/task-*): one poll loop fans out events
// to subscribers that set task.prUrl and wake reconcile on merge. Catches up on
// PRs opened before boot on its first tick. Disable with PM_GITHUB_WATCH_INTERVAL_MS=0.
startGithubWatch();

console.log(`supervisor listening on http://localhost:${app.server?.port}`);
