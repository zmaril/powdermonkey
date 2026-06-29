# Spike: SSH front-end (a text mirror of the single pane of glass)

> Goal: `ssh -p 4522 localhost` and get an experience like the web app — watch the
> plan, see live sessions, and drop into an agent's shell — all over SSH. A spike to
> see how far Bun + ssh2 + our existing tmux/PTY backend get us there.

## TL;DR

- **It works, entirely in-process.** The supervisor now also speaks SSH. Connect and
  you land in a full-screen TUI (the PowderMonkey dashboard, in text): a **Plan** view
  (the live Goal→Milestone→Task→Phase tree), an **Active** view (live sessions), and a
  **Notes** view (`@notes`). From Active, `enter` drops you straight into a session's
  shell; `s` attaches the supervisor's own `claude`.
- **The attached shell is the *same* tmux session the web Shell pane uses.** So a
  browser tab and an SSH client are two windows onto one live agent — no new PTY
  plumbing. Detach with the usual tmux chord (`Ctrl-b d`) and you're back at the
  dashboard.
- **`ssh2` runs clean on Bun** (1.3.11): server + client handshake, PTY shell, and
  `utils.generateKeyPairSync` for the host key (no `ssh-keygen` needed). That was the
  main de-risking question and it's a non-issue.
- **No auth, loopback only** — single-operator, matching design.md's non-goals. The
  port binds `127.0.0.1` and accepts any credential. Don't expose it; tunnel if remote.

## Shape

Two halves, deliberately split:

- **Transport** — `src/server/ssh.ts`. Owns a persisted ed25519 host key
  (`data/ssh_host_ed25519`, mode 0600), accepts connections, and bridges an SSH
  channel to a PTY. A `shell` request spawns the TUI in a Bun PTY and pumps bytes +
  window-change resizes; an `exec` request (`ssh host status`) runs the TUI once in
  `--snapshot` mode and exits. It knows nothing about the dashboard — the TUI is just a
  terminal program it runs, exactly like the web Shell pane spawns a shell.
- **Front-end** — `src/tui/`. A standalone terminal app that talks to the same HTTP
  API the browser does (`/plan/markdown`, `/sessions`, `/session-tasks`, `/tasks`,
  `/notes`). `model.ts` shapes the API snapshot into the dashboard and `render.ts`
  turns it into screen text — both pure, so they unit-test without a terminal
  (`tests/tui.test.ts`). `main.ts` is the runtime (raw-mode keys, alt-screen paint, a
  2s poll, and the attach-into-tmux gesture). It runs over SSH *and* locally via
  `powdermonkey tui`.

Why a separate process per connection rather than rendering in-process? Because
attaching to a live agent needs a real PTY for tmux to inherit. Giving the TUI its own
PTY (the one ssh2 hands us) means `tmux attach` just works with inherited stdio — the
TUI is a normal terminal program, and the same binary serves the local CLI.

```
ssh client ──tcp──▶ ssh2 Server (in the supervisor) ──PTY──▶ bun src/tui/main.ts
                                                                   │ HTTP  ▲ keys
                                                                   ▼       │
                                                          supervisor API   │
                                                                           │
   on `enter`/`s`: TUI execs `tmux attach` in its own PTY ────────────────▶ the SAME
   durable pm-session-<id> the web Shell pane attaches to
```

## Try it

```sh
bun run dev                 # supervisor + SSH front-end (logs the ssh line on boot)
ssh -p 4522 127.0.0.1       # → the dashboard
ssh -p 4522 127.0.0.1 status  # → a one-shot snapshot, no TTY
powdermonkey tui            # the same dashboard, locally, against $PM_URL
```

Knobs: `PM_SSH_PORT` (4522), `PM_SSH_HOST` (127.0.0.1), `PM_SSH=0` to disable.

## What's deliberately left for later

- **Read-only-ish.** The TUI watches and attaches; it doesn't yet drive the plan
  (start/land/dispatch, edit phases). The API is right there — these are follow-ups.
- **Checkout/dev only.** The TUI is run as a separate `bun <file>`; the
  `bun build --compile` binary doesn't ship it as a standalone file yet. Fine for the
  spike (which targets the dev/checkout supervisor).
- **No host-key trust UX.** First connect warns about an unknown host key as usual;
  the key is stable across restarts (persisted), so it's a one-time accept.
