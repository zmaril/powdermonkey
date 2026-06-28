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

**The plan as markdown (review & edit as text).** The whole plan tree round-trips through markdown, so reviewing and editing a plan is reviewing and editing text:

```
GET  $PM_URL/plan/markdown     # → the live plan as markdown (headings + a phase checklist)
POST $PM_URL/plan/markdown     # { "markdown": "..." } → reconcile the edited text back into the plan
```

Each node carries a trailing id chip so the round-trip is lossless:

```markdown
# Ship auth `g1`
> let users log in

## Tokens `m1`

### JWT issuing `t1`
- [ ] write tests `p1`
- [x] implement `p2`
```

On `POST`, a node that keeps its `` `g1` ``/`` `m1` ``/`` `t1` ``/`` `p1` `` chip is **updated**; a node with **no** chip is **created**; a live node whose id is **dropped** from the text is **archived**; document order is its position; a checked box (`- [x]`) marks a phase done. So you can hand the operator the markdown, take their edits, and `POST` it straight back. (Phase done-state is normally reconciliation's job; prefer editing structure/titles here and let `main` drive completion.)

**Suggest vs. just-do-it (proposals as markdown).** When the operator *tells* you to change the plan, edit directly (CRUD or the markdown round-trip). When you're *suggesting* a change yourself, author a **proposal** instead — a pending change-set the operator reviews and approves/rejects:

```
POST $PM_URL/proposals               # { title, summary, changes:[ {op,kind,...} ] }  (op = create|update|archive|reorder)
GET  $PM_URL/proposals/pending       # the decision queue
GET  $PM_URL/proposals/:id/markdown  # the proposal projected onto the plan, as markdown — review/diff it as text
POST $PM_URL/proposals/:id/approve   # then
POST $PM_URL/proposals/:id/apply     # apply the approved change-set atomically (409 if the plan moved under it)
POST $PM_URL/proposals/:id/reject
```

`GET /proposals/:id/markdown` renders the proposal's *resulting* plan as markdown (created nodes appear chip-less), so it diffs cleanly against `GET /plan/markdown` — that diff is what the operator reviews.

**Don't fake progress.** Phase/task completion is owned by reconciliation (trailers on `main`). Never `PATCH` a phase to `status: "done"` to "finish" work — it'll be wrong and reconciliation is the source of truth.

**Closing non-reconcilable work (the override path).** Some work genuinely finishes but never lands a trailer (a squash dropped it, out-of-band work, a phase-less task), and some tasks are won't-do. When the operator asks you to close such a thing, use the dedicated override endpoints — **always with `{ "source": "supervisor" }`** so the call is honestly attributed to you, not disguised as a `main` reconciliation (that's the difference from faking progress: it's recorded as `decision_source = supervisor`, never `reconciled`). This is NOT for work that *should* land a trailer — prefer a real PR + trailer whenever the work can produce one.

- `POST $PM_URL/phases/:id/complete` — mark one phase done (rolls its task up when that finishes it).
- `POST $PM_URL/tasks/:id/complete` — mark a whole task done (closes its remaining phases too).
- `POST $PM_URL/tasks/:id/cancel` — close a task as **won't-do**: a terminal `cancelled` status (archived, never counted as done).
- `POST $PM_URL/{phases|tasks}/:id/reopen` — walk an override call back (refused on reconciled rows — those belong to `main`).

```sh
curl -s -X POST $PM_URL/tasks/42/cancel   -H 'content-type: application/json' -d '{"source":"supervisor"}'
curl -s -X POST $PM_URL/phases/137/complete -H 'content-type: application/json' -d '{"source":"supervisor"}'
```

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

### Hand a follow-up back instead of doing it or dropping it

Mid-task you'll spot things **out of scope** for the task you're on — a bug in a neighbouring file, a cleanup, a "we should also…". Don't do it (that's scope creep, and it muddies your PR) and don't just drop it (it's lost). **Hand it back** as a *follow-up*: it lands as a pending **proposal** (a `create task` change-set) in the operator's decision queue, who approves it into the plan or rejects it — the same review flow as any proposal. Keep doing your actual task.

How you send it depends on where you run:

**Local worktree** — you can reach the API, so POST it:

```sh
curl -s -X POST "$PM_URL/followups" -H 'content-type: application/json' -d '{
  "title": "Dedup the date helpers in src/web",
  "body": "Spotted two copies of formatRelative while working t41 — worth one shared util.",
  "sourceTaskId": 41
}'
```

`title` is all that's required; `body` (context) and `sourceTaskId` (the task you were on — it picks which milestone the proposed task hangs under) make the proposal sharper. That's it — keep working.

**Cloud session** — you can't reach `$PM_URL`, so leave a marked comment on your PR and the supervisor's github-watch loop slurps it into the same queue. Mark it with `<!-- pm:followup -->`, one comment per follow-up (these are append-only — *not* the sticky status comment, don't overwrite that):

```
<!-- pm:followup -->
title: Dedup the date helpers in src/web
body: Spotted two copies of formatRelative while working this task — worth one shared util.
```

`title:` is the one-liner; everything after it is the optional `body`. The watcher ties the follow-up back to your PR/task automatically and ingests each comment exactly once — so post a new marked comment per follow-up and otherwise leave it alone. Don't put follow-ups in commit trailers; trailers are only for `PM-Phase:` / `PM-Task:` completion.

### Status comment (cloud sessions): keep the operator looking over your shoulder

A cloud session runs out of sight of the supervisor. Your link back is a **marked status comment on your PR**, carrying `<!-- pm:status -->`. The supervisor's github-watch loop finds the **newest** comment with that marker, parses the block below, persists it, and surfaces it live on the Active panel (state chip, summary, a `blocked` → *needs-you* flag, and the full comment body on expand). This is how a remote worker stops being a black box.

**You can't edit comments — post a fresh one each update.** The cloud environment gives you no comment-edit tool; you can only POST new comments. So the contract is **append-only**: every status update is a **brand-new comment** carrying the marker. Don't try to find-and-rewrite a previous one — you can't, and you don't need to. The marker plus **newest-wins** is the whole contract: the watcher always reads the most recent marked comment, so the latest one you post is your live status. Older marked comments pile up and are simply superseded — that's fine, the operator doesn't care about the trail.

**On startup, immediately** — before you start the real work — open your PR (draft is fine) and post your first marked status comment *already carrying a live status*. The comment **existing with real content is itself the "it booted and is alive" signal**; don't post an empty placeholder. Go `status: starting`, then post a new one at `status: working` once you're underway:

```
<!-- pm:status -->
status: working
summary: one line on what's happening right now
next: one line on what's next (or the decision you're blocked on)
session: https://claude.ai/code/session_<your-session-id>
```

- `status:` is one of `starting` | `working` | `blocked` | `done` (the canonical set is the `AgentState` enum in `src/shared/types.ts` — anything else is parsed as "no recognised status" and won't drive the panel). Use **`blocked`** when you need the operator — it lights up a *needs-you* flag on their panel. Use `done` when the PR is ready for review.
- `summary:` / `next:` are one line each, written for a human glancing at the panel. The whole comment body is shown verbatim on expand, so you can add more narrative below the block if it helps — just keep the keys at the top.
- `session:` is a link to **this cloud session** — the `https://claude.ai/code/…` URL for this run (the same one the harness gives you in the `Claude-Session:` commit trailer). It maps the status (and its PR) straight back to your session, and keeps things unambiguous if several agents ever post status comments on one PR. Stamp it on every comment so each status traces back to you; omit the line only if you genuinely can't determine your session URL.

**Post a fresh marked comment at the end of every turn.** Don't look for a prior comment to edit — just POST a new one with the current status. With `gh`:

```sh
PR=<your pr number>
gh pr comment "$PR" --body "$(cat <<'BODY'
<!-- pm:status -->
status: working
summary: …
next: …
session: https://claude.ai/code/session_<your-session-id>
BODY
)"
```

Also **keep the PR title and description current** as the work takes shape — they're the other always-visible signal the supervisor reads.
