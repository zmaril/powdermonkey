import { and, isNotNull, isNull } from "drizzle-orm";
import { SessionKind, SessionState } from "../shared/types.ts";
import { repoRepo } from "./crud.ts";
import { db } from "./db.ts";
import { prepareLaunch, sessionStartup } from "./dispatch.ts";
import { lsVmNames, newVm, rmVm, sshVm, vmHost, writeVmFile } from "./exe.ts";
import { type Session, sessions } from "./schema.ts";
import { killSessionPty, registerSessionHost, startSessionPty } from "./session-pty.ts";
import { createSessionForTasks, taskIdsForSession } from "./session-tasks.ts";
import { shq } from "./tmux.ts";

// An exe session is start-local's off-box sibling: instead of cutting a git
// worktree on this machine, it provisions a disposable exe.dev VM (`ssh exe.dev
// new`), clones the task's repo there on `pm/task-<id>`, and runs the same
// `claude "$(cat prompt)"` in tmux ON THE VM — the whole box is the isolation
// unit, so a worker can wedge or trash its machine without touching the
// supervisor, its DB, or its sibling sessions. The merge path is untouched: the
// worker pushes and opens a PR, and reconciliation reads the PM-Phase trailers
// off main exactly as for the other two session kinds. Teardown is `ssh exe.dev
// rm` — see docs/exe-dev-migration.md (phase 2) for the design.

/** Ensure the worker toolchain exists on a fresh VM. Idempotent (each leg checks
 *  before installing) so re-running is cheap; PM_EXE_BOOTSTRAP_CMD overrides —
 *  point it at `true` when the account's default VM image already has the tools. */
const DEFAULT_BOOTSTRAP = [
  "command -v tmux >/dev/null 2>&1 && command -v git >/dev/null 2>&1" +
    " || (sudo apt-get update -q && sudo apt-get install -y -q tmux git)",
  "command -v claude >/dev/null 2>&1 || curl -fsSL https://claude.ai/install.sh | bash",
].join(" && ");

function bootstrapCmd(): string {
  return process.env.PM_EXE_BOOTSTRAP_CMD ?? DEFAULT_BOOTSTRAP;
}

/** The git URL the VM clones a slug from. Falls back to the supervisor's clone
 *  base — but note the credential difference: the VM has no operator credential
 *  helper, so private repos need a token baked into PM_EXE_CLONE_BASE (e.g.
 *  `https://x-access-token:<token>@github.com/`). */
function vmCloneUrl(slug: string): string {
  const base = process.env.PM_EXE_CLONE_BASE ?? process.env.PM_CLONE_BASE ?? "https://github.com/";
  return `${base}${slug}.git`;
}

// The VM-side workspace for a session's clone, relative to the remote $HOME (ssh
// commands land there, so relative paths need no home discovery round-trip).
function vmWorkdir(primaryTaskId: number): string {
  return `pm/task-${primaryTaskId}`;
}

function vmPromptPath(sessionId: number): string {
  return `pm/prompts/session-${sessionId}.md`;
}

export type StartExeResult =
  | {
      ok: true;
      session: Session;
      vm: string;
      workdir: string;
      branch: string;
      prompt: string;
      trailers: string[];
    }
  | { ok: false; error: string; output?: string };

export async function startExeSession(
  taskIds: number | number[],
  opts: { comment?: string } = {},
): Promise<StartExeResult> {
  const prep = await prepareLaunch(taskIds, opts.comment);
  if (!prep.ok) return prep;
  const { prompt, trailers, ids, primary } = prep;

  // An exe worker starts from a clone of the task's repo — there is no local
  // checkout to fall back on, so a repo-less task (the supervisor-checkout path
  // start-local supports) can't run here.
  const repoId = prep.tasks[0].repoId;
  const repo = repoId ? await repoRepo.get(repoId) : null;
  if (!repo) {
    return { ok: false, error: "exe session needs a repo-pinned task (no repo to clone)" };
  }

  const vm = await newVm();
  if (!vm.ok) return vm;
  const host = vmHost(vm.name);
  // From here on the VM exists; any failure tears it back down (best-effort — a
  // crash in this window leaks the VM until the sweep or the operator's `ls`).
  const fail = async (error: string, output?: string): Promise<StartExeResult> => {
    const rm = await rmVm(vm.name);
    if (!rm.ok) console.warn(`start-exe: could not rm ${vm.name} after failure: ${rm.output}`);
    return { ok: false, error, output };
  };

  const boot = bootstrapCmd();
  if (boot) {
    const r = await sshVm(host, boot);
    if (!r.ok) return fail(`VM bootstrap failed on ${vm.name}`, r.output);
  }

  const workdir = vmWorkdir(primary);
  const branch = `pm/task-${primary}`;
  const clone = await sshVm(
    host,
    `git clone --branch ${shq(repo.defaultBranch)} ${shq(vmCloneUrl(repo.slug))} ${shq(workdir)}` +
      ` && git -C ${shq(workdir)} switch -c ${shq(branch)}`,
  );
  if (!clone.ok) return fail(`git clone failed on ${vm.name}`, clone.output);

  // One session row for all the tasks, exactly like start-local — the vm column is
  // what makes teardown and the leak sweep able to find the box again.
  const session = await createSessionForTasks(
    { kind: SessionKind.Exe, state: SessionState.Running, branch, vm: vm.name },
    ids,
  );

  // Stash the prompt on the VM (outside the clone, so the agent never commits it),
  // then bring up the worker's durable tmux there. If the supervisor holds a Claude
  // token, hand it to the worker through a 0600 env file sourced by the startup
  // command — headless VMs have no browser to complete an interactive login.
  const promptPath = vmPromptPath(session.id);
  const wp = await writeVmFile(host, promptPath, `${prompt}\n`);
  if (!wp.ok) return fail(`could not write prompt to ${vm.name}`, wp.output);

  let startup = sessionStartup(promptPath);
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (token) {
    const envPath = `pm/prompts/session-${session.id}.env`;
    const we = await writeVmFile(host, envPath, `export CLAUDE_CODE_OAUTH_TOKEN=${shq(token)}\n`);
    if (!we.ok) return fail(`could not write worker env to ${vm.name}`, we.output);
    startup = `. ${envPath}; ${startup}`;
  }
  startSessionPty(session.id, workdir, startup, host);

  return { ok: true, session, vm: vm.name, workdir, branch, prompt, trailers };
}

export type TeardownResult = { ok: true } | { ok: false; error: string; output?: string };

/** Tear down an exe session's VM. `force: false` is the land path and mirrors
 *  local land's "don't destroy unfinished work" stance — but stricter: a local
 *  worktree's commits survive teardown in the clone, while `exe rm` destroys the
 *  only copy of anything not pushed. So land refuses a dirty clone AND unpushed
 *  commits; `force: true` (stop) skips the checks and razes the box. A VM that's
 *  already unreachable (deleted by hand, or `rm` raced us) never blocks. */
export async function teardownExeWorkspace(
  session: Session,
  opts: { force: boolean },
): Promise<TeardownResult> {
  if (!session.vm) return { ok: true };
  const host = vmHost(session.vm);
  // Heal the in-memory host map (lost on supervisor restart) so killSessionPty
  // reaches the VM's tmux rather than looking for a local session.
  registerSessionHost(session.id, host);

  if (!opts.force) {
    const ids = await taskIdsForSession(session.id);
    const workdir = ids.length > 0 ? vmWorkdir(ids[0]) : null;
    if (workdir) {
      // ok+output tells us about the clone; a failed ssh/missing dir means there's
      // nothing left to protect — fall through to rm.
      const status = await sshVm(host, `git -C ${shq(workdir)} status --porcelain`);
      if (status.ok && status.output !== "") {
        return {
          ok: false,
          error: "exe workspace is dirty (commit or clean it first, or stop the session)",
          output: status.output,
        };
      }
      const unpushed = await sshVm(
        host,
        `git -C ${shq(workdir)} log --branches --not --remotes --oneline`,
      );
      if (unpushed.ok && unpushed.output !== "") {
        return {
          ok: false,
          error: "exe workspace has unpushed commits (push them first, or stop the session)",
          output: unpushed.output,
        };
      }
    }
  }

  killSessionPty(session.id);
  const rm = await rmVm(session.vm);
  if (!rm.ok) {
    if (!opts.force)
      return { ok: false, error: `exe.dev rm ${session.vm} failed`, output: rm.output };
    console.warn(`stop: exe.dev rm ${session.vm} (non-fatal): ${rm.output}`);
  }
  return { ok: true };
}

/** Delete VMs whose sessions are already archived — the backstop for teardowns
 *  that crashed between archiving the row and `exe rm` finishing. Only names
 *  recorded on a session row are ever deleted (never someone's unrelated VM), and
 *  a name attached to any LIVE session is skipped even if an archived row also
 *  claims it. Cheap when idle: the ls happens only if candidates exist. */
export async function sweepExeVms(): Promise<number> {
  const archived = await db
    .select({ id: sessions.id, vm: sessions.vm })
    .from(sessions)
    .where(and(isNotNull(sessions.vm), isNotNull(sessions.archivedAt)));
  if (archived.length === 0) return 0;

  const live = await db
    .select({ vm: sessions.vm })
    .from(sessions)
    .where(and(isNotNull(sessions.vm), isNull(sessions.archivedAt)));
  const inUse = new Set(live.map((r) => r.vm));

  const ls = await lsVmNames();
  if (!ls.ok) return 0;
  const existing = new Set(ls.names);

  let removed = 0;
  for (const row of archived) {
    if (!row.vm || inUse.has(row.vm) || !existing.has(row.vm)) continue;
    const rm = await rmVm(row.vm);
    if (rm.ok) removed++;
    else console.warn(`exe sweep: rm ${row.vm} failed: ${rm.output}`);
  }
  return removed;
}
