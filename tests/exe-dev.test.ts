import { expect, test } from "bun:test";
import { setupTestDb, tmp } from "./db-harness.ts";

// Pure helpers + the dry-run orchestration of the exe.dev backend. PM_EXE_DRY_RUN
// makes provision/teardown fabricate results, so nothing here shells out to exe.dev.
// (setupTestDb runs because importing exe-dev.ts pulls in settings.ts → db.ts.)
process.env.PM_EXE_DRY_RUN = "1";
process.env.PM_EXE_HOST_SUFFIX = ".exe.xyz";
const { ready } = await setupTestDb();
await ready();

const {
  sanitize,
  workerName,
  workerHost,
  ttydUrl,
  bootstrapScript,
  provisionWorker,
  teardownWorker,
  teardownRemoteWorker,
} = await import("../src/server/exe-dev.ts");

const CFG = {
  template: "powdermonkey",
  ttydPort: 3456,
  claudeFlags: "--dangerously-skip-permissions",
  autoTeardown: true,
};

test("sanitize keeps only DNS-safe chars, lowercased", () => {
  expect(sanitize("Acme/Widget_2.0")).toBe("acmewidget20");
  expect(sanitize("plain-name")).toBe("plain-name");
});

test("workerName is pm-<repo>-<task>-<rand>, from the slug's repo, and DNS-safe", () => {
  expect(workerName("acme/Widget", 7, 123)).toBe("pm-widget-7-123");
  // The full slug's owner is dropped (basename), and the result stays ≤60 chars.
  const long = workerName("org/" + "x".repeat(80), 99, 12345);
  expect(long.length).toBeLessThanOrEqual(60);
  expect(long.startsWith("pm-")).toBe(true);
});

test("workerHost + ttydUrl compose the reachable host and session URL", () => {
  expect(workerHost("pm-widget-7-123")).toBe("pm-widget-7-123.exe.xyz");
  expect(ttydUrl("pm-widget-7-123.exe.xyz", 3456)).toBe("https://pm-widget-7-123.exe.xyz:3456/");
});

test("bootstrapScript injects the slug/flags safely and drives clone+tmux+ttyd", () => {
  const s = bootstrapScript(CFG, "acme/widget", "widget");
  // Injected values are single-quoted (shq), so a slug can't break out of the assignment.
  expect(s).toContain("REPO_SLUG='acme/widget'");
  expect(s).toContain("CLAUDE_FLAGS='--dangerously-skip-permissions'");
  expect(s).toContain("TTYD_PORT='3456'");
  // The pipeline: gh clone → runner → detached tmux → ttyd.
  expect(s).toContain('gh repo clone "$REPO_SLUG" "$work"');
  expect(s).toContain("tmux -L pm new-session -d -s worker");
  expect(s).toContain("ttyd -p");
  // The prompt is read on the worker at launch, not shell-quoted through layers.
  expect(s).toContain('\\"\\$(cat /tmp/pm-prompt.md)\\"');
});

test("provisionWorker (dry-run) returns a VM name + ttyd URL without spawning", async () => {
  const res = await provisionWorker({ slug: "acme/widget", taskId: 7, promptPath: "/tmp/p.md", cfg: CFG });
  if (!res.ok) throw new Error(res.error);
  expect(res.vmName).toMatch(/^pm-widget-7-\d+$/);
  expect(res.url).toBe(ttydUrl(workerHost(res.vmName), 3456));
});

test("teardownWorker (dry-run) succeeds", async () => {
  const r = await teardownWorker("pm-widget-7-123");
  expect(r.ok).toBe(true);
});

test("teardownRemoteWorker is a no-op for non-exe.dev sessions", async () => {
  // No throw, nothing to tear down when there's no vmName or it's a local session.
  await teardownRemoteWorker({ kind: "remote", vmName: null });
  await teardownRemoteWorker({ kind: "local", vmName: "pm-x-1-1" });
  expect(true).toBe(true);
});
