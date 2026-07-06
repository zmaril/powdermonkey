# Plan: exe.dev as the default hosting platform

**Status: proposed — nothing in this document is built yet.**

This is the plan for making [exe.dev](https://exe.dev) the default place PowderMonkey
runs: the supervisor + web UI first (replacing the Docker + Tailscale recipe in
[docker.md](docker.md) as the recommended always-on setup), and then all agent
harness execution (local sessions on exe.dev worker VMs instead of the
supervisor's own box).

## Why exe.dev fits this app

PowderMonkey is deliberately *not* a twelve-factor web app. The supervisor
assumes it **is** a long-lived Linux machine: it drives tmux on a private socket,
cuts git worktrees on the local filesystem, shells out to `git`/`gh`/`claude`,
and persists everything in an embedded single-writer PGlite store
(`src/server/db.ts`, `src/server/writer-lock.ts`). That rules out every
"deploy a container, get replicas" platform (Fly, Render, Cloud Run) without a
rearchitecture — and it is exactly the shape exe.dev sells:

- **A persistent Ubuntu VM you SSH into** — root, `apt`, systemd, persistent
  disk that survives reboots. tmux, git worktrees, and PGlite's writer lock all
  just work; the runtime model doesn't change at all.
- **A private HTTPS front door with built-in auth.** Every VM gets
  `https://<vm>.exe.xyz/` with automatic TLS, **private by default**: visitors
  are redirected to an exe.dev login, and only identities on the VM's share
  list ever reach the app. PowderMonkey has no auth by design (`src/server/cors.ts`,
  the `/pty` socket is a live shell) — today Tailscale is the mandatory security
  boundary. exe.dev's share list replaces that boundary with zero moving parts on
  our side: no tailnet, no auth key, no sidecar container.
- **Scriptable VM lifecycle over SSH.** `ssh exe.dev new --json`, `ls --json`,
  `rm <vm>` — a supervisor process can provision and destroy worker VMs
  programmatically with nothing but an SSH key. That's the substrate phase 2
  builds the remote executor on.
- **Fleet-friendly pricing.** The personal plan is a flat price for a pooled
  bundle (on the order of 50 VMs / 100 GB pooled disk, VMs defaulting to
  25 GB with `--disk` to resize). One-VM-per-agent-session is economically
  sane, which is not true of most VPS providers.

What we give up versus Tailscale: the private network between *client devices*.
exe.dev only fronts HTTP(S); the browser/Tauri client talks to the supervisor
over `https://<vm>.exe.xyz/`, authenticated by exe.dev's login. That is the
correct trade — the only thing we ever exposed on the tailnet was this one
HTTP origin anyway.

## Target architecture

```
Phase 1 (lift-and-shift)                Phase 2 (worker fleet)

browser / desktop app                   browser / desktop app
        │  exe.dev login                        │  exe.dev login
        ▼                                       ▼
https://<vm>.exe.xyz ── exe proxy       https://<vm>.exe.xyz ── exe proxy
        │                                       │
   supervisor VM                           supervisor VM
   (server :4500, PGlite,                  (server :4500, PGlite, reconcile)
    tmux, worktrees, claude,                    │ ssh exe.dev new/rm
    claude --remote dispatch)                   ▼
                                        pm-task-<id> VMs (one per session:
                                         clone + branch + claude in tmux)
                                                │ git push / PR
                                                ▼
                                             GitHub ──▶ reconcile on main
```

Phase 1 already satisfies "exe.dev hosts both the web server and all agent
execution" — sessions run where the supervisor runs, and the supervisor runs on
exe.dev. Phase 2 is what makes agent execution *first-class* on the platform:
isolated, disposable, parallel beyond one box.

---

## Phase 0 — validation spike (no code)

Everything below is manual, on a throwaway VM, and decides go/no-go. The
findings should be written back into this doc.

1. `ssh exe.dev new` a VM; `ssh <vm>.exe.xyz` in; `apt install tmux git gh`,
   install bun and the Claude CLI; clone the repo; `bun run build:web` and boot
   the server with `PORT=4500`.
2. **Verify the proxy end-to-end — this is the single biggest risk.** The UI is
   unusable without WebSockets: `/pty` (live terminal) and `/sync` (PGlite
   change feed) are both WS routes in `src/server/app.ts`. Check:
   - `https://<vm>.exe.xyz:4500/health` returns `{"ok":true}` (the exe proxy
     forwards ports 3000–9999; alternatively `ssh exe.dev share port <vm> 4500`
     to put it on the root URL).
   - The web UI loads, the sync feed populates panes, and a supervisor shell
     attaches and echoes keystrokes with tolerable latency.
   - Long-lived WS connections survive > 10 minutes idle (proxy idle timeouts
     would break attached shells; if they exist, we need app-level pings).
3. **Verify the share/auth boundary.** From a logged-out browser, confirm
   `https://<vm>.exe.xyz/` redirects to exe.dev login and never touches the app.
   `ssh exe.dev share add <vm> <email>` the operator; confirm access. Confirm
   the WS routes are behind the same gate as plain HTTP.
4. **Verify the toolchain on-VM:** `claude` login persists in `~/.claude`
   across reboot; `tmux -L powdermonkey` sessions survive SSH disconnect;
   `gh auth login` works; a real local session (worktree + `claude "$(cat …)"`
   in tmux) runs end to end; `PM_DISPATCH_DRY_RUN=1` dispatch works, then one
   real `claude --remote` dispatch.
5. **Verify durability:** reboot the VM; confirm the disk (PGlite data dir,
   repos, `~/.claude`) is intact and a systemd unit brings the supervisor back.
6. Measure cold-boot-to-ready time for a fresh VM (matters for phase 2 worker
   provisioning latency) and note per-VM CPU/RAM burst behaviour under a
   running Claude session.

Fallback if the spike fails (e.g. WS through the proxy is broken): keep the
Docker + Tailscale recipe as default and revisit. Nothing below gets built
until phase 0 passes.

## Phase 1 — the supervisor on one exe.dev VM (new default)

Goal: `docs/exe-dev.md` replaces `docs/docker.md` as the recommended always-on
hosting story, with a provisioning script that takes a fresh VM to a running,
login-gated supervisor.

### 1.1 Provisioning script

Add `scripts/exe/provision.sh` — idempotent, run over SSH on a fresh VM
(exe.dev gives us root + apt + systemd, so this is plain shell, no cloud-init):

- `apt-get install -y tmux git gh chromium` (chromium for the dispatch status
  reader, `PM_CHROME_PATH`), install bun, `npm i -g powdermonkey` (or copy the
  compiled binary from `bun run build:compile` — decide during the spike;
  the compiled binary avoids needing bun at all, `src/server/paths.ts` already
  supports it).
- Create `/data` on the persistent disk for `PM_DATA_DIR`, worktrees, repo
  cache, and prompt files.
- Write `/etc/powdermonkey/env` with the env seams (all already exist, no code
  needed): `PORT=4500`, `PM_DATA_DIR=/data/pgdata`, `PM_REPOS_DIR=/data/repos`,
  `PM_WORKTREE_DIR=/data/worktrees`, `PM_CHROME_PATH=…`.
- Install a systemd unit `powdermonkey.service` and enable it.
- Print the two manual steps that can't be scripted: `claude` login and
  `gh auth login` (interactive, once; both persist on disk).

Share setup stays a documented one-liner on the operator's machine, not in the
script: `ssh exe.dev share add <vm> <your-email>` — and an explicit warning to
**never** `share set-public` this VM, for the same reason docker.md forbids
publishing the port: the app has no auth of its own.

### 1.2 Process supervision: systemd outside, tmux inside

Keep the existing tmux model (`powdermonkey serve` →
`src/server/supervise.ts` backoff loop) — tmux is load-bearing for surviving
`bun --watch` restarts and for `powdermonkey attach` — and wrap it in a
minimal boot-time unit, the same division of labour docker.md uses with
`restart: unless-stopped`:

```ini
[Service]
Type=oneshot
RemainAfterExit=yes
EnvironmentFile=/etc/powdermonkey/env
ExecStart=/usr/local/bin/powdermonkey serve
WorkingDirectory=/data/repo
User=exe

[Install]
WantedBy=multi-user.target
```

systemd guarantees the tmux server + serve-loop exist after reboot; the
serve-loop keeps the server alive between reboots, exactly as today.

### 1.3 URL and client wiring

- `ssh exe.dev share port <vm> 4500` so the supervisor is at the root
  `https://<vm>.exe.xyz/`. No code change: the client already supports remote
  servers via **Settings → Server**, which pings `/health` first.
- `PM_URL` stays `http://localhost:4500` on the VM (it's the *internal* URL
  spawned shells use to reach the API — `src/server/index.ts`); the public URL
  is purely a client-side setting. Verify during the spike that nothing
  user-facing leaks the localhost URL; if something does, add a `PM_PUBLIC_URL`
  env then, not before.
- Later polish: `ssh exe.dev domain add <vm> <domain>` for a vanity domain.

### 1.4 Backups

The VM disk is persistent but a deleted VM is gone, so keep logical backups
leaving the box: a systemd timer running `powdermonkey backup` (the
version-independent JSON snapshot from `src/server/backup.ts`, see
[backups.md](backups.md)) plus an `scp` off-VM — to the operator's machine or a
second exe.dev VM. Document restore = provision fresh VM + `powdermonkey restore`.

### 1.5 Cutover and docs

1. Provision the exe.dev VM alongside the current host; run both in parallel.
2. `powdermonkey backup` on the old host → `restore` on the VM (this flow is
   already the supported cross-machine/cross-version path).
3. Point the desktop/web client at `https://<vm>.exe.xyz/`; use it as the daily
   driver for a week with the old host as fallback; then decommission.
4. Docs: new `docs/exe-dev.md` (mirroring docker.md's structure); README
   "always-on hosting" section leads with exe.dev; docker.md demoted to
   "alternative: self-hosted Docker + Tailscale" (kept — it's the fallback and
   the self-hosters' path); `.env.example` gains the exe.dev-relevant vars.

Phase 1 is almost entirely scripts + docs. Expected code changes: none, or a
single `PM_PUBLIC_URL` seam if the spike surfaces a leak.

## Phase 2 — agent execution on per-task exe.dev worker VMs

Today "local" sessions are hardwired to the supervisor's own box:
`src/server/worktree.ts` cuts a worktree on the local filesystem and
`src/server/session-pty.ts` launches `claude` in local tmux. There is no
executor abstraction — this phase creates it. The prize: each agent session
gets a disposable root-on-its-own-VM sandbox (an agent can `rm -rf` or wedge
its box without touching the supervisor, its DB, or its siblings), and
parallelism stops being bounded by one machine.

### 2.1 The executor seam

Extract the current behaviour behind an interface and add a second
implementation, selected by `PM_EXECUTOR=local|exe` (per-server default;
possibly per-task later):

```
Executor
  start(task, prompt) -> session handle     // provision + clone + branch + launch claude
  attach(session)     -> PTY stream         // feeds the existing /pty WebSocket
  status(session)     -> running | needs_input | exited
  stop(session)                             // kill + teardown
  land(session)                             // teardown after merge
```

- **LocalExecutor** — exactly today's code (`worktree.ts` + `session-pty.ts`),
  just relocated. Behaviour-preserving refactor, shippable alone.
- **ExeExecutor**:
  - *Provision:* `ssh exe.dev new --json` (name `pm-task-<id>`), wait for SSH,
    bootstrap (see 2.2), `git clone` the task's repo, `git switch -c pm/task-<id>`.
    No worktrees needed — the whole VM is the isolation unit.
  - *Launch:* write the prompt file over `scp`, then run the session command in
    tmux **on the worker** so it survives SSH drops:
    `ssh pm-task-<id>.exe.xyz tmux -L powdermonkey new-session -d 'claude "$(cat prompt.md)"'`.
  - *Attach:* wrap `ssh -t <vm>.exe.xyz tmux attach …` in the supervisor's
    existing Bun PTY (`src/server/pty.ts`). The `/pty` WebSocket, scrollback
    ring buffer, and idle→`needs_input` detection in `session-pty.ts` all keep
    working — the PTY's child is an ssh process instead of tmux directly.
    `PM_SESSION_CMD`-style env templates (`worktree.ts:54`) already prove out
    this "the launch command is a string seam" pattern.
  - *Land/stop:* `ssh exe.dev rm pm-task-<id>`. Teardown must be idempotent and
    reconcile-driven (a supervisor crash mid-session must not leak VMs — sweep
    `ssh exe.dev ls --json` for `pm-task-*` names with no matching live session,
    in the existing reconcile loop cadence).

The merge path is untouched: workers push `pm/task-<id>`, PRs merge to `main`,
and the supervisor's reconcile loop (`src/server/reconcile.ts`) reads trailers
off `main` exactly as it does for cloud-dispatched sessions. Structurally an
exe.dev worker is *a third session type between local and `claude --remote`*:
supervisor-controlled like local, remote like dispatch.

### 2.2 Worker bootstrap and credentials

- **Toolchain:** a bootstrap script (git + claude CLI + tmux) is the simple
  start; if provisioning latency is annoying, bake a base image/snapshot
  (exe.dev supports `new --image`) — decide from phase 0 timing data.
- **exe.dev control:** the supervisor VM gets an SSH key authorized on the
  exe.dev account; `new`/`ls`/`rm` are just SSH calls with
  `-o StrictHostKeyChecking=accept-new` (their documented non-interactive-agent
  guidance).
- **GitHub:** don't copy the operator's credentials onto disposable boxes. Use
  short-lived per-clone tokens or a fine-grained PAT scoped to the target repos,
  injected at provision time (`PM_CLONE_BASE` in `repo-cache.ts` already lets us
  form token URLs). Workers need push, nothing else.
- **Claude:** `CLAUDE_CODE_OAUTH_TOKEN` injected into the worker's session env,
  never written to its disk. This is the sharpest open question in the whole
  plan — headless `claude` auth on N machines under one subscription (rate
  limits, device counts) needs a deliberate answer from the spike, and is the
  most likely reason to run phase 2 behind a flag for a while.

### 2.3 Rollout

`PM_EXECUTOR=local` stays the default while `exe` stabilizes; flip the default
once a real multi-session week has gone through it. LocalExecutor is kept
permanently — it's the laptop/dev story and the fallback.

## Phase 3 — polish (as needed, unordered)

- Base image / snapshot for sub-minute worker boot.
- Custom domain on the supervisor VM.
- Cost/fleet guardrails: cap concurrent worker VMs (plan allows ~50, pooled
  disk ~100 GB and a 25 GB default per VM means the *disk pool*, not the VM
  count, binds first — shrink workers with `--disk`), surface fleet state in
  the UI, alert on leaked VMs.
- A `scripts/exe/` doctor command: checks share list, systemd unit, backup
  timer, tool versions.

## Risks and open questions

| Risk | Impact | Mitigation |
|---|---|---|
| WebSockets (`/pty`, `/sync`) through the exe proxy | Phase 1 blocker | Phase 0 test #2; fallback = stay on Tailscale |
| Proxy idle timeouts on long-lived connections | Attached shells drop | Measure in spike; add WS keepalive pings app-side if needed |
| Headless `claude` auth on worker VMs | Phase 2 blocker | Spike `CLAUDE_CODE_OAUTH_TOKEN`; keep workers colocated (phase 1 model) until solved |
| exe.dev is a young platform | Outage/pricing/product risk | docker.md path kept as documented fallback; logical backups leave the box daily |
| Pooled CPU/RAM across fleet | Noisy-neighbour between our own sessions | Cap concurrent workers; measure per-VM burst in spike |
| Supervisor VM is a SPOF (single-writer PGlite) | True today on any host | Same answer as today: backups + fast restore; not made worse by exe.dev |
| VM deletion loses the disk | Data loss | Off-VM backup timer (1.4) before anything else ships |

## Sequencing summary

1. **Phase 0** — spike on a throwaway VM; write findings into this doc. Small.
2. **Phase 1** — provision script, systemd unit, backup timer, `docs/exe-dev.md`,
   README/docs updates, cutover. Small-medium; ~no app code.
3. **Phase 2** — executor interface refactor (behaviour-preserving, ships
   alone), then ExeExecutor behind `PM_EXECUTOR`, then default flip. Medium-large;
   the only real engineering in the plan.
4. **Phase 3** — polish, driven by usage.
