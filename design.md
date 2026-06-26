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
│   Mantine UI · Zustand                                                                │
│   ┌────────────────────────┐   ┌─────────────────────────────────────────────────┐    │
│   │ Shell view             │   │ Plan progress tree                              │    │
│   │ forwarded Claude Code  │   │ Goal→Milestone→Task→Phase, rolled up            │    │
│   │ + skill → draft/approve│   │ links out to Sessions & GitHub PRs              │    │
│   └────────────────────────┘   └─────────────────────────────────────────────────┘    │
└───────────────────────────────────────│──────────────────────────────────────────────┘
                                         │ HTTP (POST plan, read state)
┌────────────────────────────── local supervisor (Bun, on main) ───────────────────────┐
│   PGlite + Drizzle (source of truth)  ·  git pull (to know state)  ·  shell exec        │
│              │                                   │                                     │
│        claude --remote                     Playwright (headless)                       │
│        exec in cloud (against main)        drives Claude Code Web:                      │
│                                            read status · auto-click "Try Again"         │
│                                            (smart backoff across all sessions)          │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

The **supervisor** runs locally on `main`, owns the state, and is the only thing that talks to the cloud. Authoring is just a Claude Code session it execs on the backend with its shell forwarded into the browser — nothing fancier than that; a skill tells that session how to talk to the PowderMonkey server. The **browser** is a thin single-pane-of-glass over it. **Playwright** is the bridge to Claude Code Web — it runs headless and acts on your behalf, polling session status and automatically clicking "Try Again" across all sessions with smart backoff.

The `git pull` on `main` is *not* for correctness of execution — the cloud execs against `main` every time regardless. It's so the supervisor knows the current state of the repo before it plans new work or reports on status.

# Data model

The plan is a nested hierarchy, but stored flat in two Drizzle/PGlite tables. Sessions live entirely outside the hierarchy. Types are derived directly from the Drizzle table definitions — no separate schema layer.

```
goals     table   ── each row embeds milestones[]   (a milestone references task ids)
tasks     table   ── each row embeds phases[]        (phases: "write tests", "implement", "wire up")
sessions  table   ── independent; not owned by any goal
```

- **Goal** — the long-term objective. A row in `goals`, with its **Milestones** as an embedded array.
- **Milestone** — a checkpoint toward the Goal. Lives inside its Goal row; points at the Tasks it needs.
- **Task** — a unit of dispatchable work. A row in `tasks`, with its **Phases** as an embedded array.
- **Phase** — author-defined sub-steps within a Task. The grain at which progress is measured.
- **Session** — one `claude --remote` run. **Independent of the hierarchy**: a single session may pull work from multiple Goals at once and complete many Phases, Tasks, and Milestones across them in the same run. Sessions are the runtime layer; the two plan tables are the authored layer.

The plan (`goals` + `tasks`) is drafted by the authoring session as JSON, validated against the Drizzle-derived types, and only persisted after you approve it. Sessions are created at runtime and are never authored.

Progress (which Phases/Tasks/Milestones are done) is never written by a session directly — it's set during **reconciliation** when a PR merges (see Flows). The plan tables hold the desired work; merged PRs on `main` are the source of truth for what's actually complete.

# Flows

**Authoring.** You talk to a backend Claude Code session (shell forwarded into the browser) about what you want. A skill tells it how to talk to the PowderMonkey server; it drafts the plan as JSON and puts it up for approval — you approve it or request edits. Nothing is persisted automatically.

**Running.** The supervisor dispatches work as `claude --remote` sessions. The cloud execs against `main` every time. The supervisor `git pull`s `main` so it knows the repo's current state before planning or checking status.

**Reconciliation.** Progress is driven by merged PRs, not by sessions self-reporting. When a PR merges, the supervisor pulls `main`, looks at what that PR was working on, and updates the plan — marking the relevant Phases/Tasks/Milestones done. This is why sessions can live outside the hierarchy and roam across Goals: the system never has to trust a session to report what it did, it reads the result off `main`.

**Monitoring.** The single pane of glass centers on the **plan progress tree** — Goal → Milestone → Task → Phase with progress rolled up from reconciliation. There is no in-app session viewer: each node links *out* to its Claude Code Web session and its GitHub PR, and you click through. Status is shown on the tree, including a "Try Again" label (a session whose inference run has finished and is waiting to resume); Playwright handles the actual re-clicking automatically with backoff. History is preserved as an archive — a browsable "book of work."

# Stack

| Concern        | Choice                                              |
|----------------|-----------------------------------------------------|
| Runtime        | Bun                                                 |
| UI             | Mantine                                             |
| State (client) | Zustand                                             |
| Storage        | PGlite + Drizzle (local, owned by supervisor)       |
| Types          | Derived from Drizzle table definitions              |
| Authoring      | Backend Claude Code, shell forwarded to browser, + skill |
| Cloud bridge   | Playwright (drives Claude Code Web)                 |
| Execution      | `claude --remote`                                   |

# Milestone 1 — smallest end-to-end slice

The thinnest path that proves the loop is worth building:

1. Define the Drizzle tables (`goals` with milestones[], `tasks` with phases[]) on PGlite; derive types from them.
2. Supervisor (Bun) with the PGlite store and a `POST /plan` endpoint that validates and loads plan JSON.
3. Draft one real plan by hand, `curl` it up (skip the forwarded authoring session for now).
4. Dispatch one Task as a `claude --remote` session; supervisor `git pull`s `main` to know current state.
5. Playwright reads that session's status back; render the plan progress tree in a minimal Mantine page with links out to the session and PR.

Everything else — the forwarded authoring session, PR-merge reconciliation, auto-"Try Again" with backoff, the book-of-work archive — layers on after this loop closes.
