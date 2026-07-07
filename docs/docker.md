# Running the supervisor in Docker (behind Tailscale)

This runs the PowderMonkey **supervisor + web UI** in a container on an always-on
host, so it keeps working after you close your laptop. The container is the
server; your browser or the Tauri desktop app is the thin client that points at
it (**Settings → Server**). See [desktop.md](desktop.md) for the client half.

Tailscale is **not optional** here. PowderMonkey has no auth by design — the
`/pty` socket is a live shell and the API runs `claude` with your credentials —
so the container is only ever reachable over your tailnet, never published to the
host or the internet. The tailnet is the security boundary.

```
  browser / desktop app ──▶  https://powdermonkey.<tailnet>.ts.net  (Tailscale Serve)
                                   │
                             tailscale (netns) ──▶ powdermonkey :4500
                                                    (PGlite · worktrees · tmux · claude)
```

## What you need

- Docker + the Compose plugin on the host.
- A **Tailscale account**, with **MagicDNS and HTTPS certificates enabled** for
  your tailnet (Admin console → DNS). Serve uses these to get an `https://` URL.
- A **Tailscale auth key** (Admin console → Settings → Keys). Reusable +
  ephemeral is convenient for a long-lived node.
- The **project checkout** you want to drive, present on the host.
- A logged-in **Claude Code** config dir (`~/.claude`) if you want cloud
  dispatch — see the caveat at the bottom.

## Setup

```sh
cp .env.example .env
# edit .env: TS_AUTHKEY, TS_HOSTNAME, REPO_PATH (and creds paths if non-default)

docker compose up -d --build
docker compose logs -f powdermonkey    # watch it boot; expect "supervisor listening"
```

Then, from any device on the tailnet, open **Settings → Server** in the web UI or
desktop app and add:

```
https://<TS_HOSTNAME>.<your-tailnet>.ts.net
```

Adding a server pings its `/health` first, so a wrong URL or a node that hasn't
come up yet fails immediately.

## How it's wired

- **`docker/Dockerfile`** — bun base + `git` + `tmux` (both hard deps: the
  supervisor drives tmux and cuts git worktrees). It builds the web bundle and
  runs `bun run src/server/index.ts` in the **foreground as PID 1** — not
  `powdermonkey serve`, which would background into tmux and let PID 1 exit and
  kill the container. Docker's `restart: unless-stopped` replaces the tmux
  auto-restart loop.
- **`tailscale` service** — joins the tailnet and, via `docker/tailscale-serve.json`,
  fronts the supervisor on HTTPS. The `powdermonkey` service uses
  `network_mode: service:tailscale`, so its only network identity is that tailnet
  node. No `ports:` are published to the host.
- **Volumes** — `pm-data` holds the PGlite plan store (`/data/pgdata`) and
  worktrees (`/data/worktrees`); **lose it and you lose your plans**. Your project
  is bind-mounted at `/workspace/repo`, and `~/.claude` / `~/.gitconfig` are
  mounted so dispatch and pushes are authenticated.

## Surviving reboots

`restart: unless-stopped` brings both containers back after a host reboot or a
crash. Nothing else to wire up — this is the container equivalent of the
tmux-auto-restart the bare-metal `powdermonkey serve` gives you.

## Cloud dispatch caveat

The image installs the Claude Code CLI (`--build-arg INSTALL_CLAUDE=false` to
skip). Dispatch (`claude --remote`) additionally needs:

- a **logged-in** `~/.claude` mounted in (the compose file does this), and
- a browser + profile for the headless status reader that scrapes the `View:`
  URL (`PM_CHROME_PATH` / `PM_BROWSER_PROFILE`) — not bundled here.

So the plan tree, editing, reconcile, and local-worktree execution work out of
the box; wiring a headless Chromium + Claude-logged-in profile into the container
is the extra step for full cloud dispatch from inside Docker. Set
`PM_DISPATCH_DRY_RUN=1` (commented in the compose file) to exercise the dispatch
flow without touching the cloud.
