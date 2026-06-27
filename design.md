# PowderMonkey Design

PowderMonkey is a tool for orchestrating many remote Claude Codes at once, for long-term solo development.

# Background

> wherein I try to capture the spirit of how I felt being a powder monkey carrying context back and forth to the slop cannons.

Coding agents have sped up the production of code tremendously. They are able to quickly accomplish tasks that would otherwise take a person with a decade or more of specialized experience to complete. Knowledge work is now a resource that you can pour over a problem, and see how much of it saturates and dissolves on its own, without human effort or intervention. What I feel myself struggling with day to day is the long term coordination of many agents working together towards related yet disparate goals.

At times, I feel like I am just ferrying information back and forth between Claude sessions. I already have a long term plan written down somewhere, with various milestones and tasks all written up. I even have little scripts that will take that plan, make an agent create prompts for other agents to use, and dispatch those agents out. However, ultimately, I still feel like I am just running back and forth, copying and pasting things, pressing Try Again in the Claude Code web interface, while losing any clear sense I had of how I am progressing on long term goals.

One might reasonably suggest Linear or Jira or any other project management software. I have found those distasteful and counterproductive when used with agents, when I am just working by myself. In my personal projects, I do not need to hold anyone accountable for delivery. I do not need a ticket that I can watch and reference during stand up. Current long term planning systems are centered around communication between humans, about creating and shipping context around to people so that they can accomplish their part of the epic task at hand. Agents can and will do most of the work for me on my personal projects, so I don't need to create as much context, or filter and shape it so much, when there's no handoff from engineering to design or marketing.

There are likely new and exciting long term planning systems out there, alternatives to the ideas in here. I've looked at most of them and found them wanting. In particular, I like Claude Code Web a lot and want to keep using it. I've been very productive with it, and would like to just make a kludge that sands off some edges that have been annoying me.

In conclusion, there are many different software factories out there, this one is mine.

# Overview

PowderMonkey is a web application that makes `claude --remote` easier to use for long-term development. It does three things:

1. **Vocabulary** — a very small language for planning and execution: Goals, Milestones, Tasks, Phases, and Sessions.
2. **Authoring** — you discuss what you want with a Claude Code session running on the backend, its shell forwarded into the browser. A skill teaches it how to talk to the PowderMonkey server; it drafts the plan and puts it up for your approval. You approve or request edits — nothing is written automatically.
3. **Running & monitoring** — a nice interface for running plans (`claude --remote`) and watching them progress (Playwright in the background gathering context and clicking through for you, redisplayed on a single pane of glass).

# Non-goals

- **Short shelf life.** This will likely be obsolete in ~3 months once frontier labs improve their remote-session interfaces. Build for now, not forever.
- **Not beautiful code.** Useful over elegant.
- **Single operator, single workspace.** Built for one person working in one monorepo at a time. No multiplayer, no auth, no security model.

# Architecture

```
┌─────────────────────────── browser (single pane of glass) ───────────────────────────┐
│   Mantine · Zustand · dockview split                                                  │
│   ┌────────────────────────┐   ┌─────────────────────────────────────────────────┐    │
│   │ Shell (xterm.js)       │   │ Plan progress tree                              │    │
│   │ live PTY in a worktree │   │ Goal→Milestone→Task→Phase, rolled up            │    │
│   │ (tabs per session)     │   │ Start local · Dispatch · Land · Reconcile       │    │
│   └────────────────────────┘   └─────────────────────────────────────────────────┘    │
└──────────────│──────────────────────────────│────────────────────────────────────────┘
        WS /pty (PTY bytes)        HTTP — Elysia + Eden (typed CRUD, /plan, /reconcile)
┌────────────────────────────── local supervisor (Bun, on main) ───────────────────────┐
│   PGlite + Drizzle (desired plan)  ·  Elysia API  ·  reconcile loop (reads main)        │
│              │                                   │                                     │
│   local session: git worktree           remote session: claude --remote                │
│   on pm/task-<id>, PTY-driven           exec in cloud (against main)                    │
│              └───────────────┬───────────────────┘                                     │
│                        branch lands on main with PM-Phase: trailers                     │
│                        → reconcile marks phases done, tasks merged                      │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

The **supervisor** runs locally on `main`, owns the desired plan, and never executes work itself. The **browser** is a thin single-pane-of-glass over it — a dockview split with a live shell on the left and the plan tree on the right — talking to the supervisor over a typed Elysia/Eden API plus a `/pty` WebSocket.

Work runs in one of two types of interchangeable **sessions**, both isolated from the supervisor's `main` checkout: a **local** session in a git worktree on `pm/task-<id>` (driven through the forwarded PTY shell), or a **remote** `claude --remote` run in the cloud. Either way the result lands on `main`; the supervisor only ever reads `main` to learn what happened. A worktree is just the on-laptop mirror of a cloud run.

# Data model

The vocabulary is fully normalized — every entity is its own Drizzle/PGlite relation with an auto-assigned integer id and an `archived_at` soft-delete column (null = live, excluded from default lists). Types are derived directly from the table definitions; request bodies are derived from the same tables via drizzle-typebox. No separate schema layer, one validation library (TypeBox, the same one Elysia speaks).

```
goals       ── id, title, objective
milestones  ── id, goal_id →,      title, position
tasks       ── id, milestone_id →, title, status, session_url, session_state, pr_url
phases      ── id, task_id →,      name, status, position
sessions    ── id, kind(local|remote), state, task_id, branch, worktree_path, url
```

- **Goal** — the long-term objective.
- **Milestone** — a checkpoint toward a Goal.
- **Task** — a unit of dispatchable work.
- **Phase** — author-defined sub-step within a Task. **The grain at which progress is measured.**
- **Session** — one run of work, **independent of the hierarchy** (a session may complete phases across many goals). `local` runs in a git worktree; `remote` is a `claude --remote` run.

Plans are authored as a **nested, id-less tree** (goal → milestones → tasks → phases) and loaded in one transaction via `POST /plan` — the loader assigns the integer ids and wires the foreign keys, so the author never references an id by hand. Everything else is edited through the typed CRUD API. Sessions are created at runtime and are never authored.

Progress is never written by a session directly. It is set during **reconciliation**, which reads `PM-Phase: <id>` / `PM-Task: <id>` trailers off commits that have landed on `main` (see Flows). The tables hold the desired work; `main` is the source of truth for what's actually done.

# Flows

**Authoring.** A plan is loaded as a nested id-less tree via `POST /plan`. (The forwarded shell makes drafting interactive — you run Claude in the browser-side terminal — but a hand-written plan curl'd up works the same.)

**Running.** Each task is started as a session. **Start local** cuts a `pm/task-<id>` worktree off `main`, records a session, and hands back the prompt plus the per-phase `PM-Phase: <id>` trailer block; you drive it through the forwarded shell in that worktree. **Dispatch remote** is the cloud equivalent (`claude --remote`). Either way work is isolated from the supervisor's `main` checkout and lands on `main` when ready.

**Reconciliation.** Progress is driven by trailers on commits that have landed on `main`, not by sessions self-reporting. A poll loop (and `POST /reconcile`) scans `git log main` for `PM-Phase: <id>` (one or more phases finished; repeatable across PRs) and the `PM-Task: <id>` shortcut (whole task), marks those phases done, and rolls a task to `merged` once its last phase lands. Idempotent. This is why a task can span several PRs and a session can roam across goals — the system reads the result off `main` rather than trusting anyone.

**Monitoring.** The single pane of glass is a dockview split: a live **shell** (xterm.js over a PTY) on the left, the **plan progress tree** on the right — Goal → Milestone → Task → Phase with progress rolled up at the phase grain. Each task carries its actions (Start local / Dispatch / Land) and a session badge, including a "Try Again" label for a remote session parked waiting to resume. History is preserved as an archive — a browsable "book of work."

# Stack

| Concern        | Choice                                                       |
|----------------|--------------------------------------------------------------|
| Runtime        | Bun                                                          |
| API            | Elysia + Eden (end-to-end typed); TypeBox validation         |
| UI             | Mantine · Zustand · dockview (split) · xterm.js (shell)      |
| Storage        | PGlite + Drizzle (local, owned by supervisor)                |
| Types          | Derived from Drizzle tables; bodies via drizzle-typebox      |
| Forwarded shell| Bun native PTY (`Bun.Terminal`) over a `/pty` WebSocket      |
| Local exec     | git worktree on `pm/task-<id>`, driven via the shell         |
| Remote exec    | `claude --remote` (cloud, against `main`)                    |
| Reconciliation | `PM-Phase:` / `PM-Task:` git trailers on `main`              |

# Status

The end-to-end loop is built and dogfoodable:

- **Normalized data model** — goals/milestones/tasks/phases/sessions, int ids, `archived_at` soft deletes.
- **Typed API** — Elysia + Eden, full CRUD per entity, drizzle-typebox bodies, nested `POST /plan` loader.
- **Reconciliation** — trailer scan on `main` (`PM-Phase:` / `PM-Task:`), phase-grained, idempotent, on a poll loop.
- **Local worktree sessions** — Start local / Land; the on-laptop mirror of `claude --remote`.
- **Forwarded shell** — Bun native PTY ↔ WebSocket ↔ xterm.js, in a dockview split (shell left, plan right).
- **Progress tree** — Goal→Milestone→Task→Phase rolled up at the phase grain.

Still ahead: remote dispatch hardening (the `claude --remote` argv + Playwright status seams are env-overridable but spike-dependent), auto-"Try Again" with backoff, an authoring skill, and the book-of-work archive.
