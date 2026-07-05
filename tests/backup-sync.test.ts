import { beforeAll, expect, test } from "bun:test";
import { setupTestDb, tmp } from "./db-harness.ts";
import { git } from "./git-helper.ts";

// Autosync + on-demand export land the store snapshot on a git branch straight from
// the object store (no working-tree churn), and import reads it back. This drives the
// whole loop against a real temp git repo (no remote — a local branch, read back via
// `git show`), proving branch export → branch import is lossless.

// A short debounce so the live-changes → snapshot path resolves within the test.
process.env.PM_AUTOSYNC_DEBOUNCE_MS = "80";
// The snapshot plumbing runs git in PM_REPO_DIR — point it at a throwaway repo.
const repoDir = tmp("pm-backup-repo-");
process.env.PM_REPO_DIR = repoDir;

const { ready } = await setupTestDb();
const { loadPlan, parsePlan } = await import("../src/server/plan.ts");
const { taskRepo, goalRepo } = await import("../src/server/crud.ts");
const { patchSettings } = await import("../src/server/settings.ts");
const bsync = await import("../src/server/backup-sync.ts");
const bsrc = await import("../src/server/backup-source.ts");

beforeAll(async () => {
  await git(repoDir, "init", "-q", "-b", "main");
  await git(repoDir, "config", "user.email", "t@t");
  await git(repoDir, "config", "user.name", "t");
  await git(repoDir, "commit", "-q", "--allow-empty", "-m", "root");
  await ready();
  await loadPlan(
    parsePlan({
      goals: [{ title: "Backup goal", milestones: [{ title: "M", tasks: [{ title: "T1" }] }] }],
    }),
  );
});

test("export to a branch is lossless: branch read-back == live snapshot", async () => {
  const res = await bsync.exportSnapshotToBranch("pm-export", { push: false });
  expect(res.rows).toBeGreaterThan(0);
  expect(res.sha).toMatch(/^[0-9a-f]{40}$/);
  expect(res.pushed).toBe(false);

  // Reading the branch back yields the same data the live store dumps right now.
  const fromBranch = await bsrc.readSnapshotFromBranch({ branch: "pm-export" });
  const live = await bsync.currentSnapshot();
  const { snapshotDataJson } = await import("../src/server/backup.ts");
  expect(snapshotDataJson(fromBranch)).toBe(snapshotDataJson(live));
  expect(fromBranch.data.goals?.some((g) => (g as { title: string }).title === "Backup goal")).toBe(
    true,
  );
});

test("export appends a commit per snapshot (every change lands in git)", async () => {
  const before = await bsync.exportSnapshotToBranch("pm-history", { push: false });
  await taskRepo.create({ milestoneId: (await taskRepo.list())[0].milestoneId, title: "T2" });
  const after = await bsync.exportSnapshotToBranch("pm-history", { push: false });
  expect(after.sha).not.toBe(before.sha);
  // The new commit chains onto the old (parent), so history accumulates.
  const parent = await gitOut(repoDir, "rev-parse", `${after.sha}^`);
  expect(parent).toBe(before.sha);
});

test("syncNow (local mode) commits the current store to the durable branch", async () => {
  await patchSettings({ syncMode: "local", syncBranch: "autosync" });
  await bsync.syncNow();
  const status = bsync.syncStatus();
  expect(status.mode).toBe("local");
  expect(status.branch).toBe("autosync");
  expect(status.lastCommit).toMatch(/^[0-9a-f]{40}$/);
  expect(status.pushed).toBe(false);

  const snap = await bsrc.readSnapshotFromBranch({ branch: "autosync" });
  expect(snap.data.goals?.length).toBeGreaterThan(0);

  // A second syncNow with no change is a no-op (no empty commit): sha unchanged.
  const firstSha = status.lastCommit;
  await bsync.syncNow();
  expect(bsync.syncStatus().lastCommit).toBe(firstSha);
});

test("startAutosync hooks the live-changes path: a write triggers a debounced sync", async () => {
  await patchSettings({ syncMode: "local", syncBranch: "autosync-live" });
  bsync.startAutosync();
  // Let the live subscriptions register before the write we assert on.
  await Bun.sleep(150);
  const priorCommit = bsync.syncStatus().lastCommit;

  await goalRepo.create({ title: "live-write goal", objective: "o" });

  // Poll until the debounced sync produces a fresh commit (bounded so it can't hang).
  let synced = false;
  for (let i = 0; i < 40; i++) {
    await Bun.sleep(50);
    const s = bsync.syncStatus();
    if (s.lastCommit && s.lastCommit !== priorCommit) {
      synced = true;
      break;
    }
  }
  expect(synced).toBe(true);
  const snap = await bsrc.readSnapshotFromBranch({ branch: "autosync-live" });
  expect(
    snap.data.goals?.some((g) => (g as { title: string }).title === "live-write goal"),
  ).toBe(true);
});

async function gitOut(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}
