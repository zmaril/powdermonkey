---
name: powdermonkey
description: Drive PowderMonkey from the supervisor shell (author & load plans, inspect/edit the vocabulary via the API, start/land sessions, reconcile) or execute a task in a worktree (commit finished phases with PM-Phase trailers). Use whenever working with PowderMonkey, a Goal/Milestone/Task/Phase, or PM-Phase / PM-Task trailers.
---

# PowderMonkey

PowderMonkey is a single-operator tool for long-term solo dev. It tracks work as **Goals → Milestones → Tasks → Phases**, and runs each task as a **Session** — either `local` (a git worktree on `pm/task-<id>`) or `remote` (`claude --remote`). The supervisor runs on `main`, owns the *desired* plan, and **never executes work itself**. Progress is read off `main`; nothing self-reports.

The API base URL is in `$PM_URL` (default `http://localhost:4500`).

There are two roles. You're in the **supervisor shell** (repo dir) → see *Driving*. You're in a **`pm/task-<id>` worktree** → see *Working a task*.

## Driving PowderMonkey (supervisor shell)

**Author a plan.** Plans are a nested, id-less tree; the loader assigns ids and wires foreign keys. `POST $PM_URL/plan`:

```json
{
  "goals": [{
    "title": "...", "objective": "...",
    "milestones": [{
      "title": "...",
      "tasks": [{
        "title": "...",
        "phases": [{ "name": "write tests" }, { "name": "implement" }]
      }]
    }]
  }]
}
```

Validation is strict (TypeBox); a malformed plan returns 422. Don't include ids — they're assigned.

**Inspect / edit.** Every entity has full CRUD: `GET/POST/PATCH/DELETE $PM_URL/{goals|milestones|tasks|phases|sessions}` (and `/:id`). `DELETE` is a **soft delete** (sets `archived_at`, hides from lists); `?archived=true` includes archived; `POST /{entity}/:id/restore` un-archives. Use these to refine a plan after loading it.

**Run & land.** `POST $PM_URL/tasks/:id/start-local` cuts a worktree + session and returns the prompt + phase trailers. `POST $PM_URL/tasks/:id/dispatch` is the remote equivalent. `POST $PM_URL/sessions/:id/land` tears down a worktree. `POST $PM_URL/reconcile` scans `main` now (it also runs on a loop).

**Don't fake progress.** Phase/task completion is owned by reconciliation (trailers on `main`). Never `PATCH` a phase to `status: "done"` to "finish" work — it'll be wrong and reconciliation is the source of truth.

**Operator notes (`@notes`).** The operator keeps a free-form notepad — scratch thoughts, reminders, context — in a `notes` table, edited from the Notes panel in the UI. It's outside the goal hierarchy and never affects progress. When the operator references **`@notes`** (e.g. "check @notes", "what's in @notes", "per @notes…"), read the current notes with:

```
GET $PM_URL/notes      # → [{ id, title, body, position, ... }], newest edits included
GET $PM_URL/notes/:id  # a single note
```

Treat the `body` of each note as operator instructions/context. The same CRUD as other entities applies (`POST`/`PATCH`/`DELETE` + soft-delete), so you can append or amend a note on request — but the operator usually writes these by hand; default to reading, and only write when asked.

## Working a task (inside a worktree)

You've been started on one **Task**, on branch `pm/task-<id>`. It has ordered **Phases**, each with a numeric id (in your prompt; or `GET $PM_URL/tasks/<id>` + `/phases` filtered by `task_id`).

**The one rule: progress is read off `main` from commit trailers.** When you finish a phase, the commit that completes it must carry a trailer in its message body:

```
implement the dispatcher

PM-Phase: 41
```

- `PM-Phase: <id>` — one phase done. **Repeatable** (several lines per commit; a task can span many commits/PRs).
- `PM-Task: <id>` — shortcut: the whole task is done (marks all its phases). Only when one commit truly finishes everything.

Commit small and often — each landed `PM-Phase:` ticks a box on the operator's tree. The operator merges `pm/task-<id>` into `main`; once your trailered commits are reachable from `main`, reconcile marks the phases done. Stay scoped to your task — other worktrees may run in parallel.
