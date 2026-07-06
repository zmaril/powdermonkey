import { shq } from "./tmux.ts";

// Plumbing for exe.dev, the VM host behind `exe` sessions. Everything is SSH:
// the *lobby* (`ssh exe.dev new/ls/rm`) manages VM lifecycle, and each VM is a
// plain Linux box reachable at `<name>.exe.xyz` with full SSH. See
// docs/exe-dev-migration.md for the model.
//
// ┌─ SEAM: confirm against a real exe.dev account ──────────────────────────┐
// │ Like dispatch.ts, the externally-defined contract lives in env-           │
// │ overridable command templates rather than hardcoded argv, so a CLI drift  │
// │ (or a test fake) is a config change, not a code change:                   │
// │   PM_EXE_CMD          lobby prefix        `ssh exe.dev`                   │
// │   PM_EXE_SSH_CMD      VM control channel  `ssh -o BatchMode=yes … {host}` │
// │   PM_EXE_SSH_TTY_CMD  VM interactive/tty  same + `-t` (tmux attach)       │
// │   PM_EXE_DOMAIN       VM host suffix      `exe.xyz`                       │
// │ `new --json` / `ls --json` output shapes are parsed leniently (any object │
// │ with a name-ish key), for the same reason.                                │
// └────────────────────────────────────────────────────────────────────────────┘

// -o BatchMode=yes: fail instead of prompting for a password (the supervisor has
// no operator at the keyboard). -o StrictHostKeyChecking=accept-new: exe.dev's own
// non-interactive-agent guidance — fresh VMs are always unknown hosts.
const SSH_OPTS = "-o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new";

function lobbyArgv(...args: string[]): string[] {
  const prefix = (process.env.PM_EXE_CMD ?? "ssh exe.dev").split(/\s+/).filter(Boolean);
  return [...prefix, ...args];
}

function sshArgv(host: string, tty: boolean): string[] {
  const tmpl = tty
    ? (process.env.PM_EXE_SSH_TTY_CMD ?? `ssh -t ${SSH_OPTS} {host}`)
    : (process.env.PM_EXE_SSH_CMD ?? `ssh ${SSH_OPTS} {host}`);
  return tmpl.replaceAll("{host}", host).split(/\s+/).filter(Boolean);
}

/** The SSH host a VM answers at: `<name>.exe.xyz` (PM_EXE_DOMAIN overrides). */
export function vmHost(name: string): string {
  return `${name}.${process.env.PM_EXE_DOMAIN ?? "exe.xyz"}`;
}

export type ExeResult = { ok: boolean; code: number; output: string };

async function run(argv: string[], stdin?: string): Promise<ExeResult> {
  const proc = Bun.spawn(argv, {
    // Spread env explicitly: Bun.spawn snapshots the boot environ otherwise, so
    // runtime mutations (tests overriding PM_EXE_*) wouldn't reach the child.
    env: { ...process.env },
    stdin: stdin != null ? new TextEncoder().encode(stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { ok: code === 0, code, output: (out + err).trim() };
}

/** Run a lobby command (`ssh exe.dev <args>`), asynchronously. */
export function lobby(...args: string[]): Promise<ExeResult> {
  return run(lobbyArgv(...args));
}

/** Run a shell command on a VM over the non-interactive control channel. The
 *  command is a single shell string, quoted whole so it survives ssh's re-join —
 *  the remote side runs exactly `sh -c <command>`. Optional stdin is piped through
 *  (that's how files land on the VM — no scp seam needed). */
export function sshVm(host: string, command: string, stdin?: string): Promise<ExeResult> {
  return run([...sshArgv(host, false), "--", `sh -c ${shq(command)}`], stdin);
}

/** Synchronous variant of sshVm, for the has-session style liveness probes that
 *  sit on today's synchronous tmux path (tmux.ts is spawnSync for the same reason). */
export function sshVmSync(host: string, command: string): ExeResult {
  const r = Bun.spawnSync([...sshArgv(host, false), "--", `sh -c ${shq(command)}`], {
    env: { ...process.env },
  });
  return {
    ok: r.exitCode === 0,
    code: r.exitCode ?? -1,
    output: (r.stdout.toString() + r.stderr.toString()).trim(),
  };
}

/** The supervisor-side command string that opens an interactive view onto a VM —
 *  what a PTY runs to attach to the worker's tmux (`spawnShell` execs this). */
export function vmAttachCmd(host: string, remoteCmd: string): string {
  return `exec ${sshArgv(host, true).join(" ")} -- ${shq(remoteCmd)}`;
}

/** Write a file on a VM (0600, parent dirs created) by piping content over ssh —
 *  the remote analogue of writeFileSync for prompt/env files. */
export function writeVmFile(host: string, path: string, content: string): Promise<ExeResult> {
  const q = shq(path);
  return sshVm(host, `mkdir -p "$(dirname ${q})" && umask 077 && cat > ${q}`, content);
}

// ---- lobby operations ------------------------------------------------------

/** Fish the VM name out of a lenient JSON blob: the first name-ish key on the
 *  first object found. `new --json` / `ls --json` shapes aren't pinned by a spec
 *  we control, so accept `name` / `vm` / `hostname` rather than one exact shape. */
function nameOf(obj: unknown): string | null {
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;
  for (const key of ["name", "vm", "hostname"]) {
    if (typeof o[key] === "string" && o[key]) return o[key] as string;
  }
  return null;
}

function parseJsonLoose(output: string): unknown {
  // The lobby may print banner lines around the JSON; grab the outermost
  // array/object span rather than requiring pristine output.
  const start = output.search(/[[{]/);
  if (start === -1) return null;
  const end = Math.max(output.lastIndexOf("]"), output.lastIndexOf("}"));
  if (end <= start) return null;
  try {
    return JSON.parse(output.slice(start, end + 1));
  } catch {
    return null;
  }
}

export type NewVmResult =
  | { ok: true; name: string }
  | { ok: false; error: string; output?: string };

/** Provision a fresh VM and return its lobby-assigned name. */
export async function newVm(): Promise<NewVmResult> {
  const r = await lobby("new", "--json");
  if (!r.ok) return { ok: false, error: "exe.dev new failed", output: r.output };
  const parsed = parseJsonLoose(r.output);
  const name = Array.isArray(parsed) ? nameOf(parsed[0]) : nameOf(parsed);
  if (!name) return { ok: false, error: "no VM name in exe.dev new output", output: r.output };
  return { ok: true, name };
}

/** Destroy a VM by name. Idempotent from the caller's view: deleting a VM that's
 *  already gone reports ok (the point is that it no longer exists). */
export async function rmVm(name: string): Promise<ExeResult> {
  const r = await lobby("rm", name);
  if (!r.ok && /not found|no such|unknown/i.test(r.output)) return { ...r, ok: true };
  return r;
}

/** List the account's current VM names (for the leak sweep). */
export async function lsVmNames(): Promise<{ ok: boolean; names: string[]; output?: string }> {
  const r = await lobby("ls", "--json");
  if (!r.ok) return { ok: false, names: [], output: r.output };
  const parsed = parseJsonLoose(r.output);
  if (!Array.isArray(parsed)) return { ok: false, names: [], output: r.output };
  return { ok: true, names: parsed.map(nameOf).filter((n): n is string => n !== null) };
}
