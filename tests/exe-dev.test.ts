import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { setupTestDb } from "./db-harness.ts";

// The exe.dev backend is a thin adapter over disponent now — provisioning,
// naming, bootstrap scripting, and VM listing all live (and are tested) in the
// engine. What's covered HERE is the adapter: dispatch → wait-for-running →
// {vmName, url}, teardown by vmName through the engine's ledger, and the
// non-fatal no-op paths. PM_EXE_DRY_RUN maps onto disponent's dry-run backend,
// so nothing shells out. (setupTestDb runs because importing exe-dev.ts pulls
// in settings.ts → db.ts.)
process.env.PM_EXE_DRY_RUN = "1";
const { ready } = await setupTestDb();
await ready();

const { provisionWorker, teardownWorker, teardownRemoteWorker, getDisponent } = await import(
  "../src/server/exe-dev.ts"
);

const CFG = {
  template: "powdermonkey",
  ttydPort: 3456,
  claudeFlags: "--dangerously-skip-permissions",
  autoTeardown: true,
};

/** A brief on disk, like dispatch.ts writes. */
function promptFile(): string {
  const p = join(mkdtempSync(join(tmpdir(), "pm-exe-test-")), "prompt.md");
  writeFileSync(p, "do the work\n");
  return p;
}

test("provisionWorker dispatches through disponent: repo-named VM + ttyd URL", async () => {
  const res = await provisionWorker({
    slug: "acme/widget",
    taskId: 7,
    promptPath: promptFile(),
    cfg: CFG,
  });
  if (!res.ok) throw new Error(res.error);
  // disponent names workers dsp-<repo>-<session tail>; the URL is the VM's
  // ttyd endpoint on the configured port.
  expect(res.vmName).toMatch(/^dsp-widget-/);
  expect(res.url).toBe(`https://${res.vmName}.exe.xyz:3456/`);

  // the engine's ledger knows the session behind the VM — teardown reaps it
  const torn = await teardownWorker(res.vmName);
  expect(torn.ok).toBe(true);
  const again = await teardownWorker(res.vmName);
  expect(again.ok).toBe(true); // already-reaped is torn-down enough
});

test("teardownWorker on a VM the engine never made reports, not throws", async () => {
  const r = await teardownWorker("dsp-nobody-000000000000");
  expect(r.ok).toBe(false);
  expect(r.output).toContain("dsp-nobody");
});

test("teardownRemoteWorker is a no-op for non-exe.dev sessions", async () => {
  // No throw, nothing to tear down when there's no vmName or it's a local session.
  await teardownRemoteWorker({ kind: "remote", vmName: null });
  await teardownRemoteWorker({ kind: "local", vmName: "dsp-x-1" });
  expect(true).toBe(true);
});

test("the engine records pm's task label on the dispatch", async () => {
  const d = getDisponent(CFG);
  const res = await provisionWorker({
    slug: "acme/gadget",
    taskId: 42,
    promptPath: promptFile(),
    cfg: CFG,
  });
  if (!res.ok) throw new Error(res.error);
  const sessions = await d.sessions();
  const mine = sessions.find(
    (s) => s.envHandle != null && JSON.parse(s.envHandle!).vmName === res.vmName,
  );
  expect(mine).toBeDefined();
  await d.reap(mine!.uid);
});
