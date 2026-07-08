import { beforeAll, expect, test } from "bun:test";
import { setupTestDb, tmp } from "./db-harness.ts";

const repoDir = tmp("pm-repo-");
const bareDir = tmp("pm-bare-");
process.env.PM_REPO_DIR = repoDir;
process.env.PM_MAIN_BRANCH = "main";
// Isolate the tmux socket so nothing touches the operator's real sessions.
process.env.PM_TMUX_SOCKET = `pm-test-${process.pid}`;
// Teleport rides disponent's local backend (Stage 3): its remote-branch fetch maps
// onto `fetchRemote` and its `claude --teleport <id>` startup onto `agentCmd`.
// Dry-run that backend so nothing spawns; the on-disk checkout is disponent's
// contract (covered by disponent's own suite + the Stage-2b rendered proof), so here
// we assert teleport's ORCHESTRATION: branch discovery, disponent routing, and the
// remote→local session swap.
process.env.PM_LOCAL_DRY_RUN = "1";

const { ready } = await setupTestDb();
const { loadPlan, parsePlan } = await import("../src/server/plan.ts");
const { taskRepo, sessionRepo } = await import("../src/server/crud.ts");
const { parseTeleportId, pickWorkerBranch, teleportTask } = await import(
  "../src/server/teleport.ts"
);
const { linkSessionTasks, taskIdsForSession } = await import("../src/server/session-tasks.ts");
const { getDisponent } = await import("../src/server/disponent.ts");

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
  // The teleported session is disponent-local (engine uid parked in vm_name).
  expect(result.session.kind).toBe("local");
  expect(result.session.vmName).toBeTruthy();

  // Remote session archived, replaced by the new local one — which is linked to
  // the same task through the join.
  expect((await sessionRepo.get(remote.id))?.archivedAt).toBeTruthy();
  expect(await sessionRepo.get(result.session.id)).toBeTruthy();
  expect(await taskIdsForSession(result.session.id)).toContain(task.id);
  // Task's remote runtime state cleared.
  expect((await taskRepo.get(task.id))?.sessionState).toBeNull();
});

test("teleport discovers the cloud worker's pushed branch and hands it to disponent to fetch", async () => {
  const tasks = (await taskRepo.list()).sort((a, b) => a.id - b.id);
  const task = tasks[1];
  const branch = `pm/task-${task.id}-feature`;

  // Simulate the cloud worker: push a descriptive branch, then drop it locally so
  // only the remote has it — teleport must discover it via `git ls-remote`.
  await git(repoDir, "checkout", "-b", branch);
  await git(repoDir, "commit", "--allow-empty", "-m", "worker change");
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

  // Spy the engine dispatch: teleport must fetch the discovered branch (fetchRemote)
  // off the clone's origin and resume the cloud run (agentCmd) — disponent then cuts
  // the worktree at the fetched tip (its contract, proven in its own suite).
  const d = getDisponent();
  const orig = d.dispatch.bind(d);
  // biome-ignore lint/suspicious/noExplicitAny: test spy over the native dispatch.
  const specs: any[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: test spy over the native dispatch.
  (d as any).dispatch = (spec: any) => {
    specs.push(spec);
    return orig(spec);
  };
  try {
    const result = await teleportTask(task.id);
    if (!result.ok) throw new Error(`${result.error}: ${result.output ?? ""}`);

    // Discovery picked the descriptive branch the worker pushed.
    expect(result.branch).toBe(branch);
    expect(result.session.vmName).toBeTruthy();
    // …and pm handed disponent the fetch of THAT branch plus the teleport resume.
    const spec = specs.at(-1);
    expect(spec.fetchRemote).toBe(true);
    expect(spec.gitRef).toBe(branch);
    expect(spec.agentCmd).toBe(`claude --teleport ${result.teleportId}`);
  } finally {
    // biome-ignore lint/suspicious/noExplicitAny: restore the native dispatch.
    (d as any).dispatch = orig;
  }
});
