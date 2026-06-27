# PowderMonkey

PowderMonkey is an alternative web interface for Claude Code. It's really nothing more than a thousand `claude -p` in a trenchcoat. You can read [`design.md`](./design.md) for more info, or the rest of this file for how to use it and why it was built.

![A powder monkey serving the guns](docs/powder-monkey.jpg)


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
tmux -L powdermonkey attach -t pm-server   # watch the server console
```

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


## Why 

Coding agents have sped up the production of code tremendously. They are able to quickly accomplish tasks that would otherwise take a person with a decade or more of specialized experience to complete. Knowledge work is now a resource that you can pour over a problem, and see how much of it saturates and dissolves on its own, without human effort or intervention. What I feel myself struggling with day to day is the long term coordination of many agents working together towards related yet disparate goals.

At times, I feel like I am just ferrying information back and forth between Claude sessions. I already have a long term plan written down somewhere, with various milestones and tasks all written up. I even have little scripts that will take that plan, make an agent create prompts for other agents to use, and dispatch those agents out. However, ultimately, I still feel like I am just running back and forth, copying and pasting things, without a clear sense of how I am progressing on long term goals.

One might reasonably suggest Linear or Jira or any other project management software. I have found those distasteful and counterproductive when used with agents, when I am just working by myself. In my personal projects, I do not need to hold anyone accountable for delivery. I do not need a ticket that I can watch and reference during stand up. Current long term planning systems are centered around communication between humans, about creating and shipping context around to people so that they can accomplish their part of the epic task at hand. Agents can and will do most of the work for me on my personal projects, so I don't need to create as much context, or filter and shape it so much, when there's no handoff from engineering to design or marketing.

There are likely new and exciting long term planning systems out there, alternatives to the ideas in here. This one is mine, wherein I try to capture the spirit of how I felt being a powder monkey carrying context back and forth to the slop cannons.