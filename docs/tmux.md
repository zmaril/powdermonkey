# tmux cheatsheet — for when PowderMonkey gets weird

PowderMonkey keeps every process it manages — the supervisor server, the
supervisor's own `claude`, and each per-task worker agent — inside tmux, on a
**private socket** so none of it ever touches your own tmux server. When the UI
stops responding, a shell hangs, or an agent gets stuck, drop to a terminal and
talk to that socket directly. This is the map.

## The private socket

Everything lives on a dedicated socket named **`powdermonkey`** (set in
`src/server/tmux.ts`; overridable with `PM_TMUX_SOCKET`). Every command below is
just plain `tmux` with `-L powdermonkey` in front — that flag is what aims tmux
at PowderMonkey's server instead of your own:

```sh
tmux -L powdermonkey ls          # list every PM-managed session
```

Because it's a separate socket, you can create, attach, and **kill sessions on it
freely** without disturbing whatever tmux sessions you're running for yourself.

### Reserved session names

`tmux -L powdermonkey ls` shows sessions with these names:

| Session            | What it is                                                            |
| ------------------ | --------------------------------------------------------------------- |
| `pm-server`        | The Bun supervisor server (the web app + API). Runs under an auto-restart loop. |
| `pm-session-0`     | The **supervisor's own `claude`** (reserved id 0 — never a real task). |
| `pm-session-<id>`  | A per-task worker agent, one per local session (`<id>` = the session id). |

## Key commands

```sh
# List everything on the socket
tmux -L powdermonkey ls

# Watch the supervisor server's console (logs, crashes, restart backoff)
tmux -L powdermonkey attach -t pm-server

# Sit at the supervisor's own claude
tmux -L powdermonkey attach -t pm-session-0

# Attach to a specific task's worker agent (session id 7 here)
tmux -L powdermonkey attach -t pm-session-7
```

Once attached, it's an ordinary tmux client: the prefix is the default
`Ctrl-b`, scroll back with `Ctrl-b [` (then arrows / PgUp; `q` to quit copy
mode), and switch sessions with `Ctrl-b (` / `Ctrl-b )`.

> The same socket is what the web UI attaches to under the hood — clicking
> **Shell** on a task opens an attach onto that task's `pm-session-<id>`. Your
> terminal attach and the browser share one live session, so you'll see the same
> screen in both.
