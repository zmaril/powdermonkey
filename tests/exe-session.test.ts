import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { setupTestDb, tmp } from "./db-harness.ts";

// The exe executor end to end — against a FAKE exe.dev (fake-exe-lobby.sh /
// fake-exe-ssh.sh: VMs are local directories, "ssh" runs commands in them) so no
// network or account is touched. Covers: provision + clone + branch + prompt +
// worker tmux on start; land's refuse-to-destroy-work guards (dirty clone,
// unpushed commits) and its teardown; stop's force teardown; and the orphaned-VM
// sweep. The real exe.dev contract lives behind the PM_EXE_* templates these
// tests override — see src/server/exe.ts.

const repoDir = tmp("pm-repo-");
process.env.PM_REPO_DIR = repoDir;
process.env.PM_MAIN_BRANCH = "main";
// Isolated tmux socket, same reasoning as worktree.test.ts — worker tmux sessions
// here must never collide with a real supervisor's.
process.env.PM_TMUX_SOCKET = `pm-exe-test-${process.pid}`;
process.env.PM_SESSION_CMD = "";
const remotesRoot = tmp("pm-remotes-");
process.env.PM_CLONE_BASE = `${remotesRoot}/`;
// The fake exe.dev: VMs live here as directories.
const fakeRoot = tmp("pm-exevms-");
process.env.PM_EXE_FAKE_ROOT = fakeRoot;
process.env.PM_EXE_CMD = `sh ${join(import.meta.dir, "fake-exe-lobby.sh")}`;
process.env.PM_EXE_SSH_CMD = `sh ${join(import.meta.dir, "fake-exe-ssh.sh")} {host}`;
process.env.PM_EXE_SSH_TTY_CMD = `sh ${join(import.meta.dir, "fake-exe-ssh.sh")} {host}`;
// The default bootstrap apt-gets and curls; the "VM" is this machine, so skip it.
process.env.PM_EXE_BOOTSTRAP_CMD = "true";
// Keep the run deterministic whether or not the operator's shell has a token
// (a set token adds an env-file write on start — harmless, but untested here).
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

const { ready } = await setupTestDb();
const { loadPlan, parsePlan } = await import("../src/server/plan.ts");
const { taskRepo, sessionRepo, repoRepo } = await import("../src/server/crud.ts");
const { startExeSession, sweepExeVms } = await import("../src/server/exe-session.ts");
const { landSession, stopSession } = await import("../src/server/worktree.ts");
const { hasSessionPty } = await import("../src/server/session-pty.ts");
const { tmux } = await import("../src/server/tmux.ts");

const SLUG = "acme/widget";

import { git } from "./git-helper.ts";

afterAll(() => {
  tmux("kill-server");
});

beforeAll(async () => {
  await ready();
  // A local "remote" the fake VM clones from (and can push back to).
  const remote = join(remotesRoot, `${SLUG}.git`);
  const seed = tmp("pm-seed-");
  await git(seed, "init", "-b", "main");
  await git(seed, "commit", "--allow-empty", "-m", "root");
  await git(seed, "clone", "--bare", seed, remote);

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
  const repo = await repoRepo.create({ slug: SLUG, owner: "acme", name: "widget" });
  for (const task of await taskRepo.list()) {
    await taskRepo.update(task.id, { repoId: repo.id });
  }
}, 30_000);

test("start-exe provisions a VM, clones the repo on pm/task-<id>, and runs the worker tmux there", async () => {
  const [task] = (await taskRepo.list()).sort((a, b) => a.id - b.id);
  const result = await startExeSession(task.id);
  if (!result.ok) throw new Error(`${result.error}: ${result.output ?? ""}`);

  // The session row records the VM so teardown/sweep can find the box again.
  expect(result.session.kind).toBe("exe");
  expect(result.session.vm).toBe(result.vm);
  expect(result.branch).toBe(`pm/task-${task.id}`);
  expect(result.trailers[0]).toMatch(/^PM-Phase: \d+/);

  // On the "VM": the clone is on the session branch, and the prompt landed
  // outside it (never committed by the agent).
  const vmDir = join(fakeRoot, result.vm);
  const clone = join(vmDir, result.workdir);
  expect(existsSync(join(clone, ".git"))).toBe(true);
  const head = Bun.spawnSync(["git", "-C", clone, "branch", "--show-current"]);
  expect(head.stdout.toString().trim()).toBe(result.branch);
  const prompt = await Bun.file(join(vmDir, `pm/prompts/session-${result.session.id}.md`)).text();
  expect(prompt).toContain("PM-Phase:");

  // The worker's durable tmux is up on the VM (probed over the ssh seam).
  expect(hasSessionPty(result.session.id)).toBe(true);
  // Dispatching moved the task off "pending".
  expect((await taskRepo.get(task.id))?.status).toBe("dispatched");
}, 30_000);

test("land refuses a dirty clone, refuses unpushed commits, then tears the VM down", async () => {
  const [session] = await sessionRepo.list();
  if (!session.vm) throw new Error("no vm on session");
  const ids = (await taskRepo.list()).map((t) => t.id).sort((a, b) => a - b);
  const clone = join(fakeRoot, session.vm, `pm/task-${ids[0]}`);

  // Dirty clone → land must not delete the only copy of the work.
  await Bun.write(join(clone, "wip.txt"), "uncommitted");
  const dirty = await landSession(session.id);
  expect(dirty.ok).toBe(false);
  if (!dirty.ok) expect(dirty.error).toContain("dirty");

  // Committed but unpushed → still the only copy; still refused.
  await git(clone, "add", "wip.txt");
  await git(clone, "commit", "-m", "wip");
  const unpushed = await landSession(session.id);
  expect(unpushed.ok).toBe(false);
  if (!unpushed.ok) expect(unpushed.error).toContain("unpushed");

  // Pushed → safe to raze. The VM is gone and the session row is archived.
  await git(clone, "push", "origin", `pm/task-${ids[0]}`);
  const landed = await landSession(session.id);
  if (!landed.ok) throw new Error(`${landed.error}: ${landed.output ?? ""}`);
  expect(existsSync(join(fakeRoot, session.vm))).toBe(false);
  expect((await sessionRepo.get(session.id))?.archivedAt).toBeTruthy();
  expect(hasSessionPty(session.id)).toBe(false);
}, 30_000);

test("stop force-deletes the VM, work and all, and re-pends the task", async () => {
  const tasks = (await taskRepo.list()).sort((a, b) => a.id - b.id);
  const task = tasks[1];
  const started = await startExeSession(task.id);
  if (!started.ok) throw new Error(`${started.error}: ${started.output ?? ""}`);
  const vmDir = join(fakeRoot, started.vm);
  // Dirty the clone — stop must raze the box anyway (that's what abort means).
  await Bun.write(join(vmDir, started.workdir, "scratch.txt"), "in-flight work");

  const result = await stopSession(started.session.id);
  if (!result.ok) throw new Error(`${result.error}: ${result.output ?? ""}`);

  expect(result.session.state).toBe("stopped");
  expect(existsSync(vmDir)).toBe(false);
  expect((await sessionRepo.get(started.session.id))?.archivedAt).toBeTruthy();
  expect((await taskRepo.get(task.id))?.status).toBe("pending");
}, 30_000);

test("sweep deletes VMs of archived sessions and leaves live sessions' VMs alone", async () => {
  // A "crashed teardown": the session row got archived but its VM survived.
  mkdirSync(join(fakeRoot, "leakvm"));
  const leaked = await sessionRepo.create({ kind: "exe", state: "stopped", vm: "leakvm" });
  await sessionRepo.archive(leaked.id);
  // A live exe session whose VM must NOT be swept.
  mkdirSync(join(fakeRoot, "livevm"));
  await sessionRepo.create({ kind: "exe", state: "running", vm: "livevm" });

  const removed = await sweepExeVms();
  expect(removed).toBe(1);
  expect(existsSync(join(fakeRoot, "leakvm"))).toBe(false);
  expect(existsSync(join(fakeRoot, "livevm"))).toBe(true);

  // Idempotent: the leaked VM is gone, so a second sweep is a no-op.
  expect(await sweepExeVms()).toBe(0);
}, 30_000);
