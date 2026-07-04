# PowderMonkey

> [!WARNING]
> **Work in progress.** PowderMonkey has mostly been tested on itself, and is very
> new — it breaks in fun and exciting ways. Expect rough edges.

PowderMonkey helps you plan and execute long term projects via coding agents in the cloud through Github and Claude Code.

![A powder monkey serving the guns](docs/powder-monkey.jpg)

## Background 

Coding agents are now able to quickly accomplish tasks that would otherwise take a person with a decade or more of specialized experience to complete. Knowledge work is now a resource that you can pour over a problem, and see how much of it saturates and dissolves on its own, without human effort or intervention. What I feel myself struggling with day to day is the long term coordination of many agents working together towards related yet disparate goals.

At times, I feel like I am just ferrying information back and forth between Claude sessions. I often already have a long term plan written down somewhere, with various milestones and tasks all written up and ready to go. I might even have little scripts that will take that plan, make an agent create prompts for other agents to use, and dispatch those agents out to the cloud. However, ultimately, I still feel like I am just running back and forth, copying and pasting things, without a clear sense of how I am progressing on long term goals.

One might reasonably suggest Linear or Jira or any other project management software. I have found those distasteful and counterproductive when I am just working by myself. In my personal projects, I do not need or want to hold anyone accountable for delivery, there's no need for a ticket that can be reported on at stand up. Current long term planning systems are centered around communication between humans, about creating and shipping context around to people so that they can accomplish their part of the larger task at hand. Agents can and will do most of the work for me on my personal projects, so I don't need to create as much context, or filter and shape it so much, when there's no handoff from engineering to design or marketing. 

In short, there are many new and exciting software factories out there, but this one is mine. It is not meant to solve enterprise problems, just the problems of an enterprising young man. I've open sourced it because I think others might enjoy using it and have new ideas to add that would make it even better to use. PowderMonkey has solved a lot of my agent coordination isuses and I hope it can do the same for you!

## Install

```bash
npm install -g powdermonkey   # puts `powdermonkey` on PATH
```

Then, from inside any project you want to drive:

```bash
powdermonkey serve     # launch the supervisor (web app + API) in tmux for THIS project
powdermonkey attach    # watch it all: one tmux pane per live session + the server
```

`powdermonkey` operates on the **current directory** — the project's plan store
lives in its `data/` — while the code is served from wherever it was installed, so
one install drives any number of projects.

Prefer the short name? `powdermonkey alias` symlinks a `pm` next to it (opt-in, so
it never silently squats `pm` on your PATH); after that `pm serve` / `pm attach`
work too.

**Runtime dependencies.** macOS/Linux, with **tmux** and **git** on PATH (git is
how the supervisor cuts worktrees and reads progress off `main`). The npm install
also needs **bun** (it runs the TypeScript directly). If you'd rather not install
bun, grab the **standalone binary** — a single self-contained executable; tmux and
git are then the only things it needs:

```bash
bun run build:compile                 # → dist/ : the binary + its sidecar data files
mv dist ~/.local/powdermonkey         # keep the binary together with its data files
ln -s ~/.local/powdermonkey/powdermonkey ~/.local/bin/powdermonkey   # put it on PATH
```

`build:compile` bundles bun's runtime, the web UI, the DB migrations, and PGlite's
WASM. The binary finds its sidecar files (`public/`, `drizzle/`, `postgres.*`) next
to itself, so keep `dist/`'s contents together — a symlink on PATH is fine (it
resolves back to the real location). Cross-platform prebuilt binaries are the
planned distribution.

To hack on PowderMonkey itself, run from a checkout instead (below).

## Desktop client / remote servers

The browser UI is a thin client over the supervisor, and the two don't have to be
on the same machine. You can run the supervisor on a host somewhere and point a
**desktop app** (Tauri) or another browser at it — pick the server in **Settings →
Server**. Because there's no auth (by design), keep the supervisor on a private
network (Tailscale / SSH tunnel / VPN), not a public address. Run it locally and
it's the same single-machine setup as before. See **[docs/desktop.md](docs/desktop.md)**
for the model, the build steps (`bun run desktop:dev` / `desktop:build`), and the
network/auth notes.

## Run (dev)

```bash
bun install
bun run build:web   # bundle the Mantine app → public/assets/
bun run dev         # supervisor + UI on http://localhost:4500 (foreground)
```

For a long-running operator session, run the supervisor in its own tmux pane on
the private `powdermonkey` socket instead — it then outlives the launching
terminal and auto-restarts (with backoff) if it crashes:

```bash
bun run serve                              # launch (idempotent); prints attach cmd
bun run attach                             # watch it all: one tmux pane per session
```

`bun run serve` / `bun run attach` are the in-checkout equivalents of
`powdermonkey serve` / `powdermonkey attach` (they run the same `bin/powdermonkey.ts`).
Either way, attach opens a tmux dashboard with one pane per live session plus the
server console — the operator's view onto everything PowderMonkey is running. The web
UI surfaces the same command behind its **Attach** button.

Load the seed plan (PowderMonkey's own roadmap) so the tree has something to show:

```bash
curl -X POST localhost:4500/plan -H 'content-type: application/json' \
  --data-binary @examples/plan.json
```

The PGlite store lives under `data/pgdata/` and is migrated automatically on
first boot. To change the schema, edit `src/server/schema.ts`, then
`bun run db:generate` (drizzle-kit writes a migration into `drizzle/`, applied at
next boot). Run the tests with `bun test`.

### Dispatching to the cloud

A dispatched task runs as a `claude --remote` cloud session in an **isolated
workspace** — a fresh sandbox that clones the repo, does the work, and opens a PR.

> [!IMPORTANT]
> **The Claude GitHub App must be installed on the repo, or cloud workers can't
> push.** The sandbox pushes via the GitHub App, not your local `gh` token, and
> app installs are scoped per account (each org and each personal user is
> separate). If a repo's account doesn't have the app, the worker comes up with no
> push auth/remote and fails with errors about not knowing which repo to push to —
> even for a public repo (it can clone but not push).
>
> Fix: run **`/install-github-app`** inside Claude Code *from that repo* (or add
> the repo under github.com → Settings → Applications → Claude). Repos under an org
> that already has the app "just work"; a personal repo usually needs this once.

Implementation notes:

- Cloud sessions are **interactive-only** — `claude --remote` rejects `--print`/`-p`,
  and the CLI needs a **TTY**, so dispatch runs the command in a PTY (spawned with
  plain pipes it falls back to a bundled `cli.js` under whatever `node` is on PATH,
  which may be an unsupported version that crashes). It prints a `View:` URL on
  success, which is captured and stored on the session.
- `PM_DISPATCH_CMD` — overrides the dispatch command (default
  `claude --remote "$(cat {prompt_file})"`; `{prompt_file}` is the per-task prompt).
- `PM_CHROME_PATH` / `PM_BROWSER_PROFILE` — Chrome binary and a persistent profile
  so the headless Playwright status reader inherits your Claude login.

Set `PM_DISPATCH_DRY_RUN=1` to exercise the dispatch flow without touching the
cloud. `claude` must be installed and logged in.


## How progress is tracked (the PM-Note trailer)

Progress is read off `main`, never self-reported. When a worker finishes a phase,
the commit that completes it carries a **PM-Note** — one structured JSON object on
its own line in the commit message:

```
implement the dispatcher

PM-Note: {"v":1,"phases":[41]}
```

One note per commit carries everything the commit signals:

- `phases: [<id>, …]` — the phase ids this commit finished (a task spans many commits/PRs).
- `task: <id>` — shortcut: marks every phase of the task done.
- `followups: [{ "title": "…", "body": "…" }]` — hand an out-of-scope find back to the
  operator's decision queue (see below), instead of a separate PR comment.

The reconciler scans the commit bodies reachable from `main` for these notes and ticks
the matching phases/tasks. It runs on a loop and whenever a PR merges, and it's
idempotent — re-seeing a done phase is a no-op. The tree fills in as branches land on
`main`. Follow-ups are read straight off the open PR's commits, so they reach the
decision queue before the PR even merges.

> [!NOTE]
> **Why a commit-message trailer and not a git note (`refs/notes/*`)?** A spike proved
> a real git note can't carry this: a cloud (`claude --remote`) worker can't push a
> notes ref (the Claude Code git proxy 403s any non-branch ref), and a note doesn't
> survive a squash merge (the new commit SHA orphans it). A message trailer rides the
> ordinary branch push and is concatenated into a squash commit's body, so it survives
> both. See [docs/git-notes-spike.md](docs/git-notes-spike.md).

> [!NOTE]
> **Squash still needs the note to reach the squash message.** Like any commit-message
> trailer, a PM-Note only lands on `main` under a squash if it survives into the squash
> commit's message — which depends on your repo's squash-message setting and whether
> anyone edits it. **Merge commits and rebase merges keep it as-is**, so prefer those
> for `pm/task-*` PRs.

> [!NOTE]
> **Legacy fallback during cutover.** The older single-purpose trailers
> `PM-Phase: <id>` / `PM-Task: <id>` and the `<!-- pm:followup -->` PR comment are
> still read, so in-flight PRs and un-migrated workers keep working. They're not
> retired yet — that waits until PM-Note is proven through a full cloud dispatch →
> merge → reconcile cycle. Prefer `PM-Note:` for new work.


## CI

`.github/workflows/ci.yml` runs on every push to `main` and every PR targeting
`main`, in two jobs:

- **Lint & format (biome)** — `bun run check` (`biome check src`).
- **Tests (bun test)** — `bun run test` (the `tests/*.test.ts` suites).

To block merges on failure, mark both jobs as **required status checks** in the
branch protection rule for `main` (Settings → Branches → Branch protection
rules → Require status checks to pass before merging). With that enabled a red
run disables the merge button until it goes green.


## Operability

PowderMonkey runs the supervisor server, its own `claude`, and every per-task
worker agent inside tmux on a **private `powdermonkey` socket**, kept separate
from your own tmux server so PM can create and kill sessions without disturbing
your work. When the UI stops responding, a shell hangs, or an agent gets stuck,
drop to a terminal and talk to that socket directly:

```bash
powdermonkey attach                        # dashboard: one pane per session + server
tmux -L powdermonkey ls                    # list every PM-managed session
tmux -L powdermonkey attach -t pm-server   # watch just the server console
```

See the **[tmux cheatsheet](docs/tmux.md)** for the full set of inspect-and-recover
commands — reserved session names, detaching safely, killing a stuck session, and
finding the supervisor pane.



## Powderworks

PowderMonkey is part of [powderworks](https://github.com/zmaril?tab=repositories),
an agentic consortium building for the here and now. Its siblings:
[Straitjacket](https://github.com/zmaril/Straitjacket) keeps the slop out of the
code your agents write, and [housekeeping](https://github.com/zmaril/housekeeping)
keeps the repos they write it in squared away.

## Contributing

Issues and PRs welcome — PowderMonkey is young and opinionated, so open an
issue first if you're planning something big. Reports from real sessions help
most: what you ran, what the supervisor said, what broke.

## License

[MIT](LICENSE).
