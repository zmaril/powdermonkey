# PowderMonkey

> *Powder to every gun, monkey — keep the slop cannons fed and the magazine full!*

![A powder monkey serving the guns](docs/powder-monkey.jpg)

<sub>*"Tir"* — a naval gun crew at the cannons. Public domain, via [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Tir.jpg).</sub>


Single-operator command center for running many `claude -p` workers at once.
Local-first: your repos, your Claude Max subscription, one process.

**The design — concepts, decisions, data model, and as-built status — lives in
[`design.md`](./design.md).** This file is just how to run and use it.

## What it is

You state a **Goal** for a **Project** (a local repo, optionally scoped to a
subpath, with any secrets a worker needs). A supervisor `claude -p` pass reads
the repo and proposes a **Plan** of tasks; you review and approve it. Each task
launches a `claude -p` **worker** in its own `git worktree` on a branch. Workers
report status by curling a self-describing token API (no CLI to install). An
**attention board** shows what needs you — answer a question, review a diff, mark
done. The entities (projects, goals, plans, workstreams, tasks, sessions,
artifacts) are real tables in a local **embedded Postgres** (PGlite) via Drizzle
— the source of truth, mutated CRUD-style with **soft deletes**. Every change
also appends one row to an append-only **action log** carrying the field-level
**diff** (before→after) of the entity that changed, so you get a full audit and a
per-entity history. The board reads straight from the tables; `done` is
operator-marked, never inferred. The schema is Postgres dialect, so moving to a
real Postgres later is just swapping the client.

## Run (dev)

```bash
bun install
bun run build:web   # bundle the Mantine app → public/assets/
bun run dev         # http://localhost:4500
```

The store (`data/pgdata/`) is created and migrated automatically on first boot.
To change the schema, edit `src/server/schema.ts`, then `bun run db:generate`
(drizzle-kit writes a migration into `drizzle/`, applied at next boot).

`claude` must be installed and logged in (workers run through a login shell so
they inherit your Claude auth).

## Using it

- **Propose plan** — pick/define a Project and state a Goal; the supervisor
  drafts a Plan that shows up under **Plans** for review (Approve / Approve &
  launch / Reject).
- **+ New task** — create and launch a single task directly.
- **Board** — three columns: **Working** (the worker's ball, incl. CI fixes),
  **Needs Input** (your ball — a question to answer or a diff to review), **Done**.
- **Click a card** — see the objective, artifacts, and the branch **diff**;
  answer a question, comment, approve, mark done, or launch.

## API

| Route | Purpose |
|---|---|
| `GET /api/board` | board state, read from the live tables |
| `GET /api/actions` | the append-only action log (each row carries the entity diff) |
| `POST /api/projects · /goals · /workstreams · /tasks` | create entities |
| `POST /api/tasks/:id/answer · /comment · /approve-review · /done · /abandon` | operator actions |
| `POST /api/tasks/:id/launch` | launch a task (worktree + worker) |
| `GET /api/tasks/:id/diff` | the task branch's diff + stat |
| `POST /api/goals/:id/plan` | supervisor: propose a plan |
| `POST /api/plans/:id/approve` · `/reject` | act on a proposed plan |
| `GET /api/w/:token` | the self-describing worker API (curl this) |
| `WS /ws` | change notifications (board refetches) |

## Layout

```
drizzle/               drizzle-kit generated migrations (committed)
data/pgdata/           embedded Postgres (PGlite) data dir (gitignored)
src/
  shared/types.ts      entity + board-state shapes (server + web)
  server/
    schema.ts          Drizzle tables (Postgres dialect): live entities + actions log
    db.ts              PGlite + Drizzle: connection + migrate-on-boot
    repo.ts            CRUD + soft-delete; each mutation logs an action with the diff; getBoardState
    worker.ts          self-describing token API (/api/w/:token)
    backend.ts         WorkerBackend interface + LocalClaudeBackend (claude -p)
    dispatcher.ts      launch/worktree/spawn, boot+answer resume, plan approve, diff
    supervisor.ts      Goal → claude -p planning → proposed Plan
    index.ts           Elysia: REST + WS + static SPA (models + route groups)
  web/
    client.ts          Eden Treaty: type-safe client generated from the server's App type
    store.ts           Zustand; calls the treaty client
    Board.tsx          board, detail+diff, plans, propose, ProjectFields
```

## Status

Local-first MVP works end-to-end (Goal → plan → workers → review → done),
validated with real `claude -p` workers. See **[`design.md` §15](./design.md)**
for the full build status. Next: Dockerfile (single container).
