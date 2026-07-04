import { beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { setupTestDb, tmp } from "./db-harness.ts";

const repoDir = tmp("pm-repo-");
process.env.PM_REPO_DIR = repoDir;
process.env.PM_MAIN_BRANCH = "main";
process.env.PM_WORKTREE_DIR = join(tmp("pm-wt-"), "wt");
// Isolate the tmux socket + skip launching a real `claude` so the local-session
// teardown path (landSession) doesn't touch the operator's real sessions. See the
// matching note in worktree.test.ts.
process.env.PM_TMUX_SOCKET = `pm-test-${process.pid}`;
process.env.PM_SESSION_CMD = "";

const { ready } = await setupTestDb();
const { loadPlan, parsePlan } = await import("../src/server/plan.ts");
const { taskRepo, phaseRepo, sessionRepo } = await import("../src/server/crud.ts");
const { reconcile } = await import("../src/server/reconcile.ts");
const { startLocalSession } = await import("../src/server/worktree.ts");
const { linkSessionTasks } = await import("../src/server/session-tasks.ts");

import { git as runGit } from "./git-helper.ts";

const git = (...args: string[]) => runGit(repoDir, ...args);

beforeAll(async () => {
  await ready();
  await git("init", "-b", "main");
  await git("commit", "--allow-empty", "-m", "root");
});

test("trailers on main mark phases done and complete tasks", async () => {
  await loadPlan(
    parsePlan({
      goals: [
        {
          title: "Recon",
          milestones: [
            {
              title: "m",
              tasks: [
                { title: "tables", phases: [{ name: "a" }, { name: "b" }] },
                { title: "endpoints", phases: [{ name: "c" }] },
              ],
            },
          ],
        },
      ],
    }),
  );

  const tasks = await taskRepo.list();
  const tables = tasks.find((t) => t.title === "tables");
  const endpoints = tasks.find((t) => t.title === "endpoints");
  if (!tables || !endpoints) throw new Error("seed failed");

  const phases = await phaseRepo.list();
  const tablesPhases = phases
    .filter((p) => p.taskId === tables.id)
    .sort((a, b) => a.position - b.position);
  const [a, b] = tablesPhases;

  // One commit finishes phase `a` only; another finishes the whole endpoints task.
  await git("commit", "--allow-empty", "-m", `do a\n\nPM-Phase: ${a.id}`);
  await git("commit", "--allow-empty", "-m", `finish endpoints\n\nPM-Task: ${endpoints.id}`);

  const result = await reconcile();
  expect(result.phaseTrailers).toContain(a.id);
  expect(result.taskTrailers).toContain(endpoints.id);

  // phase a done, phase b still todo (only a was trailered)
  expect((await phaseRepo.get(a.id))?.status).toBe("done");
  expect((await phaseRepo.get(b.id))?.status).toBe("todo");

  // tables: partial → still pending; endpoints: PM-Task shortcut → merged + phases done
  expect((await taskRepo.get(tables.id))?.status).toBe("pending");
  expect((await taskRepo.get(endpoints.id))?.status).toBe("merged");
  const endpointPhases = phases.filter((p) => p.taskId === endpoints.id);
  for (const p of endpointPhases) {
    expect((await phaseRepo.get(p.id))?.status).toBe("done");
  }
});

test("PM-Note trailers on main mark phases done and complete tasks", async () => {
  await loadPlan(
    parsePlan({
      goals: [
        {
          title: "Notes",
          milestones: [
            {
              title: "m",
              tasks: [
                { title: "note-phases", phases: [{ name: "na" }, { name: "nb" }] },
                { title: "note-task", phases: [{ name: "nc" }] },
              ],
            },
          ],
        },
      ],
    }),
  );

  const tasks = await taskRepo.list();
  const notePhases = tasks.find((t) => t.title === "note-phases");
  const noteTask = tasks.find((t) => t.title === "note-task");
  if (!notePhases || !noteTask) throw new Error("seed failed");

  const phases = await phaseRepo.list();
  const [a, b] = phases
    .filter((p) => p.taskId === notePhases.id)
    .sort((x, y) => x.position - y.position);

  // One commit finishes phase `na` via a PM-Note; another finishes the whole note-task
  // with the `task` shortcut. Structured JSON payload, not the legacy single trailers.
  await git("commit", "--allow-empty", "-m", `do na\n\nPM-Note: {"v":1,"phases":[${a.id}]}`);
  await git("commit", "--allow-empty", "-m", `done\n\nPM-Note: {"v":1,"task":${noteTask.id}}`);

  const result = await reconcile();
  expect(result.phaseTrailers).toContain(a.id);
  expect(result.taskTrailers).toContain(noteTask.id);

  // phase na done, nb still todo; the note-task's shortcut merged it and closed its phase.
  expect((await phaseRepo.get(a.id))?.status).toBe("done");
  expect((await phaseRepo.get(b.id))?.status).toBe("todo");
  expect((await taskRepo.get(noteTask.id))?.status).toBe("merged");
});

test("reconcile is idempotent", async () => {
  const first = await reconcile();
  const second = await reconcile();
  // nothing new to mark on the second pass
  expect(second.phasesMarked).toBe(0);
  expect(second.tasksCompleted).toBe(0);
  expect(first.phaseTrailers).toEqual(second.phaseTrailers);
});

test("merging a task archives its live sessions; non-merged tasks are untouched", async () => {
  await loadPlan(
    parsePlan({
      goals: [
        {
          title: "Archive",
          milestones: [
            {
              title: "m",
              tasks: [
                { title: "local-merged", phases: [{ name: "x" }] },
                { title: "remote-merged", phases: [{ name: "y" }] },
                { title: "still-running", phases: [{ name: "z" }] },
              ],
            },
          ],
        },
      ],
    }),
  );

  const all = await taskRepo.list();
  const localTask = all.find((t) => t.title === "local-merged");
  const remoteTask = all.find((t) => t.title === "remote-merged");
  const runningTask = all.find((t) => t.title === "still-running");
  if (!localTask || !remoteTask || !runningTask) throw new Error("seed failed");

  // A real local session (worktree + PTY) for the task we're about to merge.
  const started = await startLocalSession(localTask.id);
  if (!started.ok) throw new Error(`start failed: ${started.error}`);
  const localSession = started.session;

  // A remote session (row only, no worktree) for another task that'll merge, plus a
  // remote session for a task that stays running and must NOT be touched.
  const remoteSession = await sessionRepo.create({
    kind: "remote",
    state: "running",
    url: "https://claude.ai/code/remote-merged",
  });
  await linkSessionTasks(remoteSession.id, [remoteTask.id]);
  const runningSession = await sessionRepo.create({
    kind: "remote",
    state: "running",
    url: "https://claude.ai/code/still-running",
  });
  await linkSessionTasks(runningSession.id, [runningTask.id]);

  // Land the two PRs on main (PM-Task shortcut merges those tasks); the running task
  // gets no trailer, so it stays pending.
  await git("commit", "--allow-empty", "-m", `merge local\n\nPM-Task: ${localTask.id}`);
  await git("commit", "--allow-empty", "-m", `merge remote\n\nPM-Task: ${remoteTask.id}`);

  const result = await reconcile();
  expect(result.sessionsArchived).toBe(2);

  // Both merged tasks' sessions are archived (and marked idle).
  const local = await sessionRepo.get(localSession.id);
  const remote = await sessionRepo.get(remoteSession.id);
  expect(local?.archivedAt).not.toBeNull();
  expect(local?.state).toBe("idle");
  expect(remote?.archivedAt).not.toBeNull();
  expect(remote?.state).toBe("idle");
  // The local session's worktree was torn down.
  expect((await taskRepo.get(localTask.id))?.status).toBe("merged");

  // The still-running task's session is left alone.
  const running = await sessionRepo.get(runningSession.id);
  expect(running?.archivedAt).toBeNull();
  expect(running?.state).toBe("running");

  // Idempotent: a second tick finds nothing left to archive.
  const again = await reconcile();
  expect(again.sessionsArchived).toBe(0);
});
