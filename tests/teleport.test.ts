import { beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setupTestDb, tmp } from "./db-harness.ts";

const repoDir = tmp("pm-repo-");
const bareDir = tmp("pm-bare-");
process.env.PM_REPO_DIR = repoDir;
process.env.PM_MAIN_BRANCH = "main";
process.env.PM_WORKTREE_DIR = join(tmp("pm-wt-"), "wt");
// Isolate the tmux socket; the teleport startup override (`claude --teleport`) runs
// in a detached session on this private socket, never the operator's.
process.env.PM_TMUX_SOCKET = `pm-test-${process.pid}`;

const { ready } = await setupTestDb();
const { loadPlan, parsePlan } = await import("../src/server/plan.ts");
const { taskRepo, sessionRepo } = await import("../src/server/crud.ts");
const { parseTeleportId, pickWorkerBranch, teleportTask } = await import(
  "../src/server/teleport.ts"
);
const { linkSessionTasks, taskIdsForSession } = await import("../src/server/session-tasks.ts");
const { killSessionPty } = await import("../src/server/session-pty.ts");

import { git } from "./git-helper.ts";

beforeAll(async () => {
  await ready();
  await git(bareDir, "init", "--bare", "-b", "main");
  await git(repoDir, "init", "-b", "main");
  await git(repoDir, "commit", "--allow-empty", "-m", "root");
  await git(repoDir, "remote", "add", "origin", bareDir);
  await git(repoDir, "push", "origin", "main");
  await loadPlan(
    parsePlan({
      goals: [
        {
          title: "G",
          milestones: [
            {
              title: "m",
              tasks: [
                { title: "fallback", phases: [{ name: "x" }] },
                { title: "discovered", phases: [{ name: "y" }] },
              ],
            },
          ],
        },
      ],
    }),
  );
});

test("parseTeleportId pulls session_ id from a remote session URL", () => {
  expect(parseTeleportId("https://claude.ai/code/session_abc123XYZ")).toBe("session_abc123XYZ");
  expect(parseTeleportId("https://claude.ai/code/session_ab-cd?x=1")).toBe("session_ab-cd");
  expect(parseTeleportId("https://claude.ai/code/no-id-here")).toBeNull();
});

test("pickWorkerBranch prefers a descriptive slug and ignores look-alikes", () => {
  // glob can return pm/task-120 (a different task) for `pm/task-12*` — must be dropped
  expect(pickWorkerBranch(["pm/task-12", "pm/task-12-slug", "pm/task-120-x"], 12)).toBe(
    "pm/task-12-slug",
  );
  expect(pickWorkerBranch(["pm/task-12"], 12)).toBe("pm/task-12");
  expect(pickWorkerBranch(["pm/task-120-x"], 12)).toBeNull();
  expect(pickWorkerBranch([], 12)).toBeNull();
});

test("teleport falls back to a fresh pm/task-<id> branch when nothing was pushed", async () => {
  const [task] = (await taskRepo.list()).sort((a, b) => a.id - b.id);
  // Stand in for a dispatched cloud session, linked to its task via the join.
  const remote = await sessionRepo.create({
    kind: "remote",
    state: "running",
    url: "https://claude.ai/code/session_fallback1",
  });
  await linkSessionTasks(remote.id, [task.id]);
  await taskRepo.update(task.id, {
    sessionUrl: "https://claude.ai/code/session_fallback1",
    sessionState: "running",
    status: "dispatched",
  });

  const result = await teleportTask(task.id);
  if (!result.ok) throw new Error(`${result.error}: ${result.output ?? ""}`);

  expect(result.branch).toBe(`pm/task-${task.id}`);
  expect(result.teleportId).toBe("session_fallback1");
  expect(existsSync(result.session.worktreePath ?? "")).toBe(true);
  expect(result.session.kind).toBe("local");

  // Remote session archived, replaced by the new local one — which is linked to
  // the same task through the join.
  expect((await sessionRepo.get(remote.id))?.archivedAt).toBeTruthy();
  expect(await sessionRepo.get(result.session.id)).toBeTruthy();
  expect(await taskIdsForSession(result.session.id)).toContain(task.id);
  // Task's remote runtime state cleared.
  expect((await taskRepo.get(task.id))?.sessionState).toBeNull();

  killSessionPty(result.session.id);
});

test("teleport discovers and checks out the cloud worker's pushed branch", async () => {
  const tasks = (await taskRepo.list()).sort((a, b) => a.id - b.id);
  const task = tasks[1];
  const branch = `pm/task-${task.id}-feature`;

  // Simulate the cloud worker: push a descriptive branch carrying a unique file,
  // then drop it locally so only the remote has it (forces the fetch path).
  await git(repoDir, "checkout", "-b", branch);
  await Bun.write(join(repoDir, "worker.txt"), "from cloud worker\n");
  await git(repoDir, "add", "worker.txt");
  await git(repoDir, "commit", "-m", "worker change");
  await git(repoDir, "push", "origin", branch);
  await git(repoDir, "checkout", "main");
  await git(repoDir, "branch", "-D", branch);

  const remote = await sessionRepo.create({
    kind: "remote",
    state: "running",
    url: "https://claude.ai/code/session_discovered1",
  });
  await linkSessionTasks(remote.id, [task.id]);
  await taskRepo.update(task.id, {
    sessionUrl: "https://claude.ai/code/session_discovered1",
    status: "dispatched",
  });

  const result = await teleportTask(task.id);
  if (!result.ok) throw new Error(`${result.error}: ${result.output ?? ""}`);

  expect(result.branch).toBe(branch);
  // The worktree was checked out at the worker's commit, not a fresh main branch.
  const wt = result.session.worktreePath ?? "";
  expect(existsSync(join(wt, "worker.txt"))).toBe(true);
  expect(readFileSync(join(wt, "worker.txt"), "utf8")).toBe("from cloud worker\n");

  killSessionPty(result.session.id);
});
