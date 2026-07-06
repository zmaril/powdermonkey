import { basename } from "node:path";
import { SessionKind } from "../shared/types.ts";
import { spawnCapture } from "./proc.ts";
import { type ExeDevConfig, getExeDevConfig } from "./settings.ts";
import { shq } from "./tmux.ts";

// The exe.dev cloud-dispatch backend. A "Dispatch remote" launch with this backend
// selected provisions a throwaway VM per task: copy an already-authed template VM
// (so claude + gh auth, git identity, bun and ttyd come along), clone the task's repo
// on it, and start claude in a tmux session exposed over ttyd. The session URL the
// operator sees is that ttyd view; the VM is torn down when the session ends.
//
// Everything shells out to the exe.dev CLI, which is itself just `ssh exe.dev <cmd>`
// (and `ssh <vm>.exe.xyz` to reach a worker). We reuse `spawnCapture` (argv arrays,
// no shell quoting) and the house `{ ok, output }` result convention. Arg-building
// and the remote bootstrap script are pure exported functions so they're unit-tested
// without touching the network; only the thin spawn wrappers go untested.

const SSH = process.env.PM_EXE_SSH ?? "ssh";
const SCP = process.env.PM_EXE_SCP ?? "scp";
// The exe.dev control endpoint and the per-VM host suffix. Overridable so tests can
// point at a local fake, and so a future self-host can retarget without code changes.
const CONTROL = process.env.PM_EXE_CONTROL ?? "exe.dev";
const HOST_SUFFIX = process.env.PM_EXE_HOST_SUFFIX ?? ".exe.xyz";
// Test seam: skip every spawn and fabricate a result (mirrors PM_DISPATCH_DRY_RUN).
const DRY_RUN = Boolean(process.env.PM_EXE_DRY_RUN);

const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new"];

export type ProvisionResult =
  | { ok: true; vmName: string; url: string }
  | { ok: false; error: string; output?: string };

export type CmdResult = { ok: boolean; output: string };

/** Run a binary, catching a synchronous spawn throw (missing `ssh`/`scp`) so a bad
 *  PATH never crashes the caller — the house degrade-cleanly convention. Merges and
 *  trims stdout+stderr into `output`, like git.ts. */
async function run(cmd: string[], stdin?: string): Promise<CmdResult> {
  try {
    const { code, stdout, stderr } = await spawnCapture(cmd, stdin != null ? { stdin } : {});
    return { ok: code === 0, output: `${stdout}${stderr}`.trim() };
  } catch (e) {
    return { ok: false, output: e instanceof Error ? e.message : String(e) };
  }
}

/** `ssh exe.dev <args>` — an exe.dev control-plane command (cp, tag, rm, ls, …). */
function sshControl(args: string[]): Promise<CmdResult> {
  return run([SSH, ...SSH_OPTS, CONTROL, ...args]);
}

/** `ssh <host> <args>` against a worker VM, optionally feeding it a script on stdin. */
function sshWorker(host: string, args: string[], stdin?: string): Promise<CmdResult> {
  return run([SSH, ...SSH_OPTS, host, ...args], stdin);
}

// ── Pure helpers (unit-tested) ───────────────────────────────────────────────────

/** Lowercase to a DNS-safe token: keep [a-z0-9-], drop everything else. */
export function sanitize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]/g, "");
}

/** A unique, DNS-safe worker VM name for a task: `pm-<repo>-<taskId>-<rand>` (≤60).
 *  The random suffix lets the same task be re-dispatched without colliding with a
 *  still-running worker. `rand` is passed in so the function stays pure/testable. */
export function workerName(slug: string, taskId: number, rand: number): string {
  const repo = sanitize(basename(slug)) || "repo";
  return `pm-${repo}-${taskId}-${rand}`.slice(0, 60);
}

/** The reachable ssh/https host for a worker VM name. */
export function workerHost(vmName: string): string {
  return `${vmName}${HOST_SUFFIX}`;
}

/** The ttyd web-terminal URL for a worker — the session URL the operator opens. */
export function ttydUrl(host: string, port: number): string {
  return `https://${host}:${port}/`;
}

/** The remote `bash -s` script that turns a fresh worker into a running session:
 *  clone the repo (via `gh`, so private repos work), write a runner, launch claude in
 *  a detached tmux session (autonomous per `cfg.claudeFlags`, attachable), and expose
 *  it over ttyd. Injected values are single-quoted (shq) so a repo slug or operator
 *  flag string can't break out. The runner keeps the prompt out of the tmux command
 *  string by `cat`-ing it at run time. */
export function bootstrapScript(cfg: ExeDevConfig, slug: string, workDir: string): string {
  const header = [
    `REPO_SLUG=${shq(slug)}`,
    `WORK_NAME=${shq(workDir)}`,
    `CLAUDE_FLAGS=${shq(cfg.claudeFlags)}`,
    `TTYD_PORT=${shq(String(cfg.ttydPort))}`,
  ].join("\n");
  // Note the escaping in the runner-emitting block: $CLAUDE_FLAGS expands now (so the
  // flags are baked in), but \"\$(cat …)\" stays literal so the prompt is read on the
  // worker at launch, never shell-quoted through layers.
  const body = String.raw`
set -e
export PATH="$HOME/.bun/bin:$PATH"
work="$HOME/work/$WORK_NAME"
rm -rf "$work"; mkdir -p "$HOME/work"
gh repo clone "$REPO_SLUG" "$work"
{
  echo '#!/usr/bin/env bash'
  echo 'export PATH="$HOME/.bun/bin:$PATH"'
  echo 'cd "$1"'
  echo "claude $CLAUDE_FLAGS \"\$(cat /tmp/pm-prompt.md)\" || true"
  echo 'exec bash'
} > "$HOME/pm-run.sh"
chmod +x "$HOME/pm-run.sh"
tmux -L pm kill-session -t worker 2>/dev/null || true
tmux -L pm new-session -d -s worker -x 220 -y 50 "$HOME/pm-run.sh \"$work\""
if command -v ttyd >/dev/null; then
  pkill -f "ttyd .*$TTYD_PORT" 2>/dev/null || true
  setsid ttyd -p "$TTYD_PORT" -W tmux -L pm attach -t worker >/tmp/ttyd.log 2>&1 &
fi
`;
  return `${header}\n${body}`;
}

// ── Orchestration ────────────────────────────────────────────────────────────────

/** Wait until a freshly-copied worker's sshd answers (a `cp` returns before the VM is
 *  fully up). Polls `ssh <host> true` up to ~90s. */
async function waitSshReady(host: string): Promise<boolean> {
  for (let i = 0; i < 45; i++) {
    const r = await run([SSH, ...SSH_OPTS, "-o", "ConnectTimeout=5", host, "true"]);
    if (r.ok) return true;
    await new Promise((res) => setTimeout(res, 2000));
  }
  return false;
}

export type ProvisionArgs = {
  slug: string;
  taskId: number;
  promptPath: string;
  cfg: ExeDevConfig;
};

/** Provision a worker VM for a task and start its claude session. Returns the VM name
 *  (for teardown) and the ttyd session URL, or a staged failure. Each step early-exits
 *  with a stage-prefixed error carrying the failed command's output. */
export async function provisionWorker(args: ProvisionArgs): Promise<ProvisionResult> {
  const { slug, taskId, promptPath, cfg } = args;
  const rand = Math.floor(Math.random() * 100000);
  const vmName = workerName(slug, taskId, rand);
  const host = workerHost(vmName);
  const url = ttydUrl(host, cfg.ttydPort);

  if (DRY_RUN) return { ok: true, vmName, url };

  // 1. Copy the authed template → worker VM (inherits claude + gh auth, bun, ttyd).
  const cp = await sshControl(["cp", cfg.template, vmName]);
  if (!cp.ok) return { ok: false, error: `exe.dev cp failed`, output: cp.output };

  // 2. Tag it so `ssh exe.dev ls` maps VM → task/repo. Best-effort; never fatal.
  const repo = sanitize(basename(slug)) || "repo";
  const tag = await sshControl([
    "tag",
    vmName,
    `pm-task-${taskId}`,
    `pm-repo-${repo}`,
    "pm-worker",
  ]);
  if (!tag.ok) console.warn(`exe-dev: tag ${vmName} (non-fatal): ${tag.output}`);

  // 3. Wait for the worker to accept ssh.
  if (!(await waitSshReady(host))) {
    return { ok: false, error: `worker ${host} never came up` };
  }

  // 4. Push the prompt.
  const scp = await run([SCP, ...SSH_OPTS, promptPath, `${host}:/tmp/pm-prompt.md`]);
  if (!scp.ok) return { ok: false, error: `scp prompt failed`, output: scp.output };

  // 5. Clone the repo + launch claude in tmux + ttyd.
  const boot = await sshWorker(host, ["bash", "-s"], bootstrapScript(cfg, slug, repo));
  if (!boot.ok) return { ok: false, error: `worker bootstrap failed`, output: boot.output };

  return { ok: true, vmName, url };
}

/** Delete a worker VM. */
export function teardownWorker(vmName: string): Promise<CmdResult> {
  if (DRY_RUN) return Promise.resolve({ ok: true, output: `dry-run rm ${vmName}` });
  return sshControl(["rm", vmName]);
}

/** Tear down the exe.dev worker backing a session, if any. A no-op unless the session
 *  is a remote exe.dev run (has a `vmName`) and auto-teardown is enabled; a failed
 *  `rm` is logged, never thrown — teardown must not block a land/stop/reconcile. */
export async function teardownRemoteWorker(session: {
  kind: SessionKind;
  vmName: string | null;
}): Promise<void> {
  if (session.kind !== SessionKind.Remote || !session.vmName) return;
  if (!getExeDevConfig().autoTeardown) return;
  const r = await teardownWorker(session.vmName);
  if (!r.ok) console.warn(`exe-dev: rm ${session.vmName} (non-fatal): ${r.output}`);
}
