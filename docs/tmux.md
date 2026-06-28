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

## The `pm attach` shortcut

Knowing the socket flag and session names is the price of raw `tmux`. The helper
hides both — run it from the repo and it drops you onto the socket:

```sh
pm attach              # the dashboard: one pane per live session + the server
pm attach pm-session-7 # …or attach straight to one named session
bun run attach         # same, without the bin/pm wrapper on your PATH
```

Bare `pm attach` builds a **dashboard** — a single tmux window that tiles one
pane per thing PowderMonkey is running (the `pm-server` console first, then each
`pm-session-<id>` agent), so you see the whole machine at once instead of one
console at a time. Each pane is a nested client attached to that session, so it's
the same live screen the browser shell shows; type into a pane to drive that
agent, `Ctrl-b d` to detach the whole dashboard. It's rebuilt from scratch each
time you run it, so it always matches what's currently live — run it again after
starting or landing a session to re-tile. Pass a session name to skip the
dashboard and attach to just that one.

`pm` is PowderMonkey's CLI — `npm install -g powdermonkey` puts it on your PATH (in
a checkout, `bun run attach` runs the same thing). It's a thin wrapper over the
`tmux -L powdermonkey attach` commands below — reach for those directly whenever you
want a specific target or flag.

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

## Recovery

### Detach without killing anything

Attaching does **not** take ownership — the session keeps running whether or not
anyone's looking at it. To leave, detach with the prefix:

```
Ctrl-b d        # detach this client; the session (and its agent) keeps running
```

Detaching is always safe. The supervisor only ever *attaches* to these sessions;
the agent inside lives independently, which is the whole point of running them in
tmux — they survive a supervisor restart (`bun run --watch` reloads on every
source edit) and a closed terminal alike. So when in doubt, `Ctrl-b d` and walk
away rather than killing.

### Kill a stuck session

If a worker agent is wedged — spinning, ignoring input, or you just want to start
it over — kill its session by name. This ends the `claude` inside it:

```sh
tmux -L powdermonkey kill-session -t pm-session-7   # kill worker for session 7
```

The clean way to retire a finished local session is the API
(`POST $PM_URL/sessions/:id/land`), which kills the tmux session *and* tears down
the worktree. Reach for a raw `kill-session` only when the server itself is
unresponsive and you need to free the agent by hand.

To restart the **server** specifically, kill its pane — the auto-restart loop is
gone with it, so relaunch:

```sh
tmux -L powdermonkey kill-session -t pm-server   # stop the server + its restart loop
bun run serve                                    # bring it back up (idempotent)
```

Nuke everything PM-managed in one shot (server, supervisor claude, all workers)
without touching your own tmux:

```sh
tmux -L powdermonkey kill-server
```

### Find the supervisor pane

There are **two** "supervisor" things, and which one you want depends on the
symptom:

- **The server console** lives in `pm-server`. Attach here when the UI is down,
  the API isn't answering, or you want to read crash logs / watch the restart
  backoff:

  ```sh
  tmux -L powdermonkey attach -t pm-server
  ```

- **The supervisor's own `claude`** (the agent you drive PowderMonkey from) lives
  in `pm-session-0` — reserved id 0, so it never collides with a real task.
  Attach here to pick the conversation back up after a restart or a closed
  terminal:

  ```sh
  tmux -L powdermonkey attach -t pm-session-0
  ```

If `tmux -L powdermonkey ls` shows nothing at all, the socket's server isn't
running — nothing is wedged, it's just down. Start it with `bun run serve` (or
`bun run dev` for a foreground supervisor) and the sessions come back.
