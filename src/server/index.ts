// PowderMonkey supervisor — local Bun process on `main`, owns state, the only
// thing that talks to the cloud.

import { app } from "./app.ts";
import { ready } from "./db.ts";
import { reconcile } from "./reconcile.ts";

const PORT = Number(process.env.PORT ?? 4500);

await ready();
app.listen(PORT);

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
      if (r.phasesMarked > 0 || r.tasksCompleted > 0) {
        console.log(`reconciled: ${r.phasesMarked} phase(s), ${r.tasksCompleted} task(s)`);
      }
    } catch (e) {
      console.warn("reconcile tick failed:", e instanceof Error ? e.message : e);
    } finally {
      running = false;
    }
  }, RECONCILE_MS);
}

console.log(`supervisor listening on http://localhost:${app.server?.port}`);
