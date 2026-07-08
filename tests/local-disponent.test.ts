import { beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { setupTestDb, tmp } from "./db-harness.ts";

// The local dispatch backend is a thin adapter over disponent's LOCAL tmux
// backend — worktree isolation, provisioning, and teardown all live (and are
// tested) in the engine. What's covered HERE is the adapter + pm's lifecycle
// wiring: dispatch(env "local", isolation "worktree", gitRef pm/task-<id>) →
// wait-for-running → {uid, workDir}; land → reap; stop → cancel; and that a
// plain start-local routes through it when PM_LOCAL_BACKEND=disponent. The seam
// PM_LOCAL_DRY_RUN maps onto disponent's dry-run local backend, so nothing
// shells out (no git worktree, no tmux, no claude).
const repoDir = tmp("pm-ld-repo-");
process.env.PM_REPO_DIR = repoDir;
process.env.PM_MAIN_BRANCH = "main";
process.env.PM_TMUX_SOCKET = `pm-ld-${process.pid}`;
// Opt the default start-local into the disponent backend, dry-run so nothing spawns.
process.env.PM_LOCAL_BACKEND = "disponent";
process.env.PM_LOCAL_DRY_RUN = "1";

const { ready } = await setupTestDb();
const { loadPlan, parsePlan } = await import("../src/server/plan.ts");
const { taskRepo, sessionRepo } = await import("../src/server/crud.ts");
const { startLocalSession, landSession, stopSession } = await import("../src/server/worktree.ts");
const { provisionLocalWorker, teardownLocalWorker, cancelLocalWorker } = await import(
  "../src/server/local-disponent.ts"
);
const { getDisponent } = await import("../src/server/disponent.ts");
const { SessionState: DState } = await import("@disponent/node");

beforeAll(async () => {
  await ready();
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

test("provisionLocalWorker dispatches env=local, isolation=worktree, gitRef=branch", async () => {
  const res = await provisionLocalWorker({
    taskId: 7,
    repoDir,
    branch: "pm/task-7",
    brief: "do the work",
  });
  if (!res.ok) throw new Error(res.error);

  // disponent names the local worker's tmux session dsp-<uid> and parks its work
  // dir under the engine root; the worktree itself lands at <workDir>/task.
  expect(res.handle.tmux).toBe(`dsp-${res.uid}`);
  expect(res.workDir).toContain(res.uid);
  expect(typeof res.handle.socket).toBe("string");

  // the engine's ledger knows the session; cancel keeps it, reap removes it.
  const d = getDisponent();
  const settled = await d.session(res.uid);
  expect(settled?.state).toBe(DState.Running);

  const cancelled = await cancelLocalWorker(res.uid);
  expect(cancelled.ok).toBe(true);
  expect((await d.session(res.uid))?.state).toBe(DState.Cancelled);

  const torn = await teardownLocalWorker(res.uid);
  expect(torn.ok).toBe(true);
  expect((await d.session(res.uid))?.reapedAt).toBeTruthy();
});

test("start-local routes through disponent: session row carries branch + engine uid", async () => {
  const [task] = await taskRepo.list();
  const result = await startLocalSession(task.id);
  if (!result.ok) throw new Error(result.error);

  expect(result.branch).toBe(`pm/task-${task.id}`);
  expect(result.session.kind).toBe("local");
  // worktree_path is disponent's <workDir>/task; the engine uid rides vm_name.
  expect(result.session.worktreePath).toBe(result.worktreePath);
  expect(result.worktreePath).toMatch(/\/task$/);
  const uid = result.session.vmName;
  expect(uid).toBeTruthy();

  // The engine actually holds a running session behind this row.
  const d = getDisponent();
  expect((await d.session(uid as string))?.state).toBe(DState.Running);
  // dispatching moved the task off "pending".
  expect((await taskRepo.get(task.id))?.status).toBe("dispatched");
});

test("land reaps the engine session and archives the row", async () => {
  const live = (await sessionRepo.list()).filter((s) => s.kind === "local");
  const session = live[0];
  const uid = session.vmName as string;

  const result = await landSession(session.id);
  if (!result.ok) throw new Error(`${result.error}: ${result.output ?? ""}`);

  // reap tore the engine session down (worktree removed there), row archived here.
  const d = getDisponent();
  expect((await d.session(uid))?.reapedAt).toBeTruthy();
  expect((await sessionRepo.list()).some((s) => s.id === session.id)).toBe(false);
  expect((await sessionRepo.get(session.id))?.archivedAt).toBeTruthy();
});

test("stop cancels the engine session (worktree kept) and re-pends the task", async () => {
  const [task] = await taskRepo.list();
  const started = await startLocalSession(task.id);
  if (!started.ok) throw new Error(started.error);
  const uid = started.session.vmName as string;

  const result = await stopSession(started.session.id);
  if (!result.ok) throw new Error(`${result.error}: ${result.output ?? ""}`);

  expect(result.session.state).toBe("stopped");
  // cancel (not reap): the engine session is cancelled but NOT reaped — the
  // worktree is left in place for inspection.
  const d = getDisponent();
  const s = await d.session(uid);
  expect(s?.state).toBe(DState.Cancelled);
  expect(s?.reapedAt).toBeFalsy();
  // archived here + task rolled back to pending so it can be re-run.
  expect((await sessionRepo.get(started.session.id))?.archivedAt).toBeTruthy();
  expect((await taskRepo.get(task.id))?.status).toBe("pending");
});

test("start-local with several task ids starts ONE disponent session for all", async () => {
  const all = (await taskRepo.list()).sort((a, b) => a.id - b.id);
  const ids = all.map((t) => t.id);

  const result = await startLocalSession(ids);
  if (!result.ok) throw new Error(result.error);

  expect(result.branch).toBe(`pm/task-${ids[0]}`);
  expect(result.session.kind).toBe("local");
  expect(result.session.vmName).toBeTruthy();
  expect(result.prompt).toContain("t2");
  expect(result.trailers).toHaveLength(2);
  for (const id of ids) {
    expect((await taskRepo.get(id))?.status).toBe("dispatched");
  }
  const live = (await sessionRepo.list()).filter((s) => s.kind === "local");
  expect(live).toHaveLength(1);

  await landSession(result.session.id);
});
