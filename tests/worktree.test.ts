import { beforeAll, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setupTestDb, tmp } from "./db-harness.ts";

const repoDir = tmp("pm-repo-");
process.env.PM_REPO_DIR = repoDir;
process.env.PM_MAIN_BRANCH = "main";
process.env.PM_WORKTREE_DIR = join(tmp("pm-wt-"), "wt");
// Isolate the tmux socket + skip launching a real `claude`. Without this the test
// would create/kill `pm-session-<id>` on the operator's shared "powdermonkey"
// socket — and since this temp DB restarts ids at 1, landSession() here would kill
// a real live session whose id happens to collide (e.g. a worker running the suite).
process.env.PM_TMUX_SOCKET = `pm-test-${process.pid}`;
process.env.PM_SESSION_CMD = "";

const { ready } = await setupTestDb();
const { loadPlan, parsePlan } = await import("../src/server/plan.ts");
const { taskRepo, sessionRepo } = await import("../src/server/crud.ts");
const { startLocalSession, landSession, stopSession } = await import("../src/server/worktree.ts");

import { git as runGit } from "./git-helper.ts";
const git = (...args: string[]) => runGit(repoDir, ...args);

beforeAll(async () => {
  await ready();
  await git("init", "-b", "main");
  await git("commit", "--allow-empty", "-m", "root");
  await loadPlan(
    parsePlan({
      goals: [
        {
          title: "G",
          milestones: [
            {
              title: "m",
              tasks: [
                { title: "t", phases: [{ name: "x" }] },
                { title: "t2", phases: [{ name: "y" }] },
              ],
            },
          ],
        },
      ],
    }),
  );
});

test("start-local creates a worktree + branch + session row with PM-Note block", async () => {
  const [task] = await taskRepo.list();
  const result = await startLocalSession(task.id);
  if (!result.ok) throw new Error(result.error);

  expect(result.branch).toBe(`pm/task-${task.id}`);
  expect(existsSync(result.worktreePath)).toBe(true);
  expect(result.trailers[0]).toMatch(/^PM-Note: \{"v":1,"phases":\[\d+\]\}/);
  expect(result.prompt).toContain("PM-Note:");

  expect(result.session.kind).toBe("local");
  expect(result.session.worktreePath).toBe(result.worktreePath);
  // dispatching moved the task off "pending"
  expect((await taskRepo.get(task.id))?.status).toBe("dispatched");
});

test("land tears down the worktree and archives the session", async () => {
  const [session] = await sessionRepo.list();
  const path = session.worktreePath;
  if (!path) throw new Error("no worktree path");

  const result = await landSession(session.id);
  if (!result.ok) throw new Error(`${result.error}: ${result.output ?? ""}`);

  expect(existsSync(path)).toBe(false);
  // archived → excluded from default list
  expect((await sessionRepo.list()).some((s) => s.id === session.id)).toBe(false);
  expect((await sessionRepo.get(session.id))?.archivedAt).toBeTruthy();
});

test("start-local with several task ids starts ONE session for all of them", async () => {
  const all = (await taskRepo.list()).sort((a, b) => a.id - b.id);
  const ids = all.map((t) => t.id);

  const result = await startLocalSession(ids);
  if (!result.ok) throw new Error(result.error);

  // One worktree/branch, named after the primary (first) task.
  expect(result.branch).toBe(`pm/task-${ids[0]}`);
  expect(result.session.kind).toBe("local");
  // The brief covers every task; trailers span all their phases.
  expect(result.prompt).toContain("t2");
  expect(result.trailers).toHaveLength(2);

  // Every selected task moved off pending — they all surface the shared session.
  for (const id of ids) {
    expect((await taskRepo.get(id))?.status).toBe("dispatched");
  }
  // Exactly one session row was created for the batch.
  const live = (await sessionRepo.list()).filter((s) => s.kind === "local");
  expect(live).toHaveLength(1);

  await landSession(result.session.id);
});

test("stop aborts a session without a clean worktree and re-pends the task", async () => {
  const [task] = await taskRepo.list();
  const started = await startLocalSession(task.id);
  if (!started.ok) throw new Error(started.error);
  // Dirty the worktree — land() refuses this; stop() must force through it.
  writeFileSync(join(started.worktreePath, "scratch.txt"), "uncommitted work");

  const result = await stopSession(started.session.id);
  if (!result.ok) throw new Error(`${result.error}: ${result.output ?? ""}`);

  expect(result.session.state).toBe("stopped");
  // worktree force-removed despite being dirty
  expect(existsSync(started.worktreePath)).toBe(false);
  // archived → excluded from default list
  expect((await sessionRepo.list()).some((s) => s.id === started.session.id)).toBe(false);
  expect((await sessionRepo.get(started.session.id))?.archivedAt).toBeTruthy();
  // task rolled back to pending so it can be re-run
  expect((await taskRepo.get(task.id))?.status).toBe("pending");
});

test("stop does NOT un-merge an already-merged task on a multi-task session", async () => {
  // One session spanning two tasks; the first finishes and merges while the
  // second is still in flight. Aborting the shared session must re-pend only the
  // unfinished task — the merged one is done regardless of the session ending.
  const all = (await taskRepo.list()).sort((a, b) => a.id - b.id);
  const [merged, unfinished] = all;

  const started = await startLocalSession([merged.id, unfinished.id]);
  if (!started.ok) throw new Error(started.error);

  // The first task merged mid-session (reconcile read its trailer off main).
  await taskRepo.update(merged.id, { status: "merged" });

  const result = await stopSession(started.session.id);
  if (!result.ok) throw new Error(`${result.error}: ${result.output ?? ""}`);

  // Merged work survives the abort; only the in-flight task rolls back to pending.
  expect((await taskRepo.get(merged.id))?.status).toBe("merged");
  expect((await taskRepo.get(unfinished.id))?.status).toBe("pending");
});

test("land tears down a merged task's session without regressing its status", async () => {
  // The graceful teardown path: a merged task's session is landed (worktree
  // removed, row archived). Unlike stop, land never touches task status — a
  // finished task must stay merged when its shared session ends.
  const [task] = await taskRepo.list();
  const started = await startLocalSession(task.id);
  if (!started.ok) throw new Error(started.error);
  await taskRepo.update(task.id, { status: "merged" });

  const result = await landSession(started.session.id);
  if (!result.ok) throw new Error(`${result.error}: ${result.output ?? ""}`);

  expect(existsSync(started.worktreePath)).toBe(false);
  expect((await sessionRepo.get(started.session.id))?.archivedAt).toBeTruthy();
  expect((await taskRepo.get(task.id))?.status).toBe("merged");
});
