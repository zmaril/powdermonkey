import { beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { setupTestDb, tmp } from "./db-harness.ts";

// start-local against a task pinned to a Repo cuts `pm/task-<id>` from that repo's
// cache clone under ~/.powdermonkey/repos — NOT the supervisor's own checkout. Since
// Stage 3 disponent's local backend cuts the worktree (given the cache-clone path as
// its `repo`), so this asserts pm resolves + hands disponent the RIGHT repo dir (via
// the dispatch spec) and that land reaps the engine session. The repo is cloned from
// a local remote so no network is touched. Local dispatch is dry-run — nothing spawns.
const repoDir = tmp("pm-repo-");
process.env.PM_REPO_DIR = repoDir;
process.env.PM_MAIN_BRANCH = "main";
const cacheRoot = tmp("pm-repos-");
const remotesRoot = tmp("pm-remotes-");
process.env.PM_REPOS_DIR = cacheRoot;
process.env.PM_CLONE_BASE = `${remotesRoot}/`;
process.env.PM_TMUX_SOCKET = `pm-test-${process.pid}`;
process.env.PM_LOCAL_DRY_RUN = "1";

const { ready } = await setupTestDb();
const { loadPlan, parsePlan } = await import("../src/server/plan.ts");
const { taskRepo, sessionRepo, repoRepo } = await import("../src/server/crud.ts");
const { startLocalSession, landSession } = await import("../src/server/worktree.ts");
const { repoCachePath } = await import("../src/server/repo-cache.ts");
const { getDisponent } = await import("../src/server/disponent.ts");
const { IsolationKind } = await import("@disponent/node");

const SLUG = "acme/widget";

import { git } from "./git-helper.ts";

beforeAll(async () => {
  await ready();
  // A local "remote" for the task's repo.
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
          milestones: [{ title: "m", tasks: [{ title: "t", phases: [{ name: "x" }] }] }],
        },
      ],
    }),
  );
  const repo = await repoRepo.create({ slug: SLUG, owner: "acme", name: "widget" });
  const [task] = await taskRepo.list();
  await taskRepo.update(task.id, { repoId: repo.id });
}, 30_000);

test("start-local hands disponent the task's cache clone as the worktree repo, and land reaps it", async () => {
  const [task] = await taskRepo.list();

  // Spy the engine dispatch to see the `repo` pm resolves for this task.
  const d = getDisponent();
  const orig = d.dispatch.bind(d);
  // biome-ignore lint/suspicious/noExplicitAny: test spy over the native dispatch.
  const specs: any[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: test spy over the native dispatch.
  (d as any).dispatch = (spec: any) => {
    specs.push(spec);
    return orig(spec);
  };
  let sessionId: number;
  try {
    const result = await startLocalSession(task.id);
    if (!result.ok) throw new Error(`${result.error}: ${result.output ?? ""}`);
    sessionId = result.session.id;

    expect(result.branch).toBe(`pm/task-${task.id}`);
    // The worktree is cut from the task's cache clone (under ~/.powdermonkey/repos),
    // NOT the supervisor's own checkout: that's the `repo` pm hands disponent, with
    // worktree isolation.
    const spec = specs.at(-1);
    expect(spec.repo).toBe(repoCachePath(SLUG));
    expect(spec.isolation).toBe(IsolationKind.Worktree);
    expect(result.session.vmName).toBeTruthy();
  } finally {
    // biome-ignore lint/suspicious/noExplicitAny: restore the native dispatch.
    (d as any).dispatch = orig;
  }

  // land reaps the engine session (worktree removed there) and archives the row.
  const landed = await landSession(sessionId);
  if (!landed.ok) throw new Error(`${landed.error}: ${landed.output ?? ""}`);
  expect((await sessionRepo.get(sessionId))?.archivedAt).toBeTruthy();
}, 30_000);
