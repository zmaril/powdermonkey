# Vocabulary

The one language PowderMonkey uses for the work, and the choices behind it. Small on
purpose. This is the canonical reference; `design.md` carries a shorter summary.

PowderMonkey is **solo operator, single supervisor** — one global instance, all state
under `~/.powdermonkey/`. There is no "workspace" entity; all of PM is one space.

## The model

```
Project ─→ Theme ─→ Task ─→ Phase          (run as Sessions)
                     │
                     └─ targets one ─→ Repo   (its environment; a flat global list)
```

Two orthogonal axes hang off the work and **meet at the Task**:

- **Planning** — *what* you're building: `Project → Theme → Task → Phase`. Repo-agnostic.
- **Repos** — *where* it runs: a flat global list of GitHub repos. A Task points at one.

And a third, separate concern — *how you look* at the work — is the **Window** (a
frontend view), which is not part of the hierarchy.

## The terms

### Project
The top of the plan tree: a long-term objective. **A root** — no parent (solo operator,
one global space). Pure planning, repo-agnostic. Id chip `p`.

### Theme
A coherent grouping of tasks toward a project — a checkpoint, an area of work, a
chapter. **Repo-agnostic**: a Theme can hold tasks across different repos. Id chip `th`
(`t` is taken by Task).

### Task
A unit of dispatchable work. **Targets exactly one Repo** — its environment. Id chip `t`.

### Phase
An author-defined sub-step within a Task. **The grain at which progress is measured**
(reconciliation marks phases done from `PM-Phase:` commit trailers on `main`). Id chip `#`.

### Repo
A **GitHub git repo** (`owner/repo`, a default branch), in a **flat global list** you
configure. **Cloud-first**: the repo of record is on GitHub. PM never treats it as a
local checkout you manage or browse — when it needs a working tree (to cut a local
session's worktree, or as a `claude --remote` cwd) it clones a **transient cache** under
`~/.powdermonkey/repos/<owner>/<repo>` on demand. A Repo is *not* a level in the Project
spine; it's what a Task points at. Id chip `r`.

### Session
One run of work, independent of the hierarchy: `local` (a git worktree) or `remote`
(`claude --remote`). A session may complete phases across several projects. Progress is
read off `main`, never self-reported.

### Window
A saved, named **view**: a panel arrangement (a dockview split) **plus a repo filter**
(which repos' work to show). You make your own and switch between them for different
modes of work; switching restores both how you're set up and what you're looking at. A
**pure frontend concern** — not part of the work hierarchy. (This is the idea Blender
calls a "Workspace"; we call it a Window so nothing is overloaded.)

## Id chips

`p` project · `th` theme · `t` task · `#` phase · `r` repo. So `p3` is a project, `th7`
a theme, `t41` a task, `#137` a phase, `r4` a repo. `th` is two letters because `t` was
already the task.

## Decisions (and why)

The model was ground out over several rounds; these are the calls and the reasoning.

1. **Goal → Project, Milestone → Theme.** Task and Phase kept. *Theme* was chosen over
   *Area* (too broad) and *Focus* (connotes present attention, clashes with the Active
   pane). A Theme reads as "an area/chapter of work," which is what it is.

2. **Panel collections are Windows, not Layouts.** A *Layout* implies a re-applyable
   template — and people rarely want templates. A *Window* is a live view you keep and
   return to. So a Window bundles its panel arrangement **and** what it's looking at,
   and you can have several Windows pointed at the same thing (a "review" window and a
   "deep work" window). It lives in an always-open left rail, not a dropdown.

3. **A Task targets exactly one Repo.** A coding session is one environment — a cloud
   agent clones one repo; you can't drive two at once outside a monorepo. So the repo is
   an attribute of the **Task**, and **only tasks sharing a repo can be dispatched in one
   session** (the UI blocks a cross-repo multi-select; the API rejects it). A **Theme can
   span repos** — the planning layer stays repo-agnostic, the repo is keyed to the task.

4. **No Workspace entity.** It churned through three shapes — a single repo, then a
   directory of repos, then a location-less grouping — before we cut it. Solo operator +
   single supervisor means there's nothing to group: all of PM is one implicit global
   space. **Projects are roots** and **Repos are a flat global list**. (You scope a *view*
   to some repos with a Window's repo filter — that replaced the workspace filter.)

5. **Cloud-first repos.** A repo is its GitHub identity (`owner/repo`), not a local
   checkout. PM keeps only transient cache clones under `~/.powdermonkey/`, cloned on
   demand and never browsed by hand. Cloud dispatch (`claude --remote`) needs no local
   auth — the cloud sandbox clones via the Claude GitHub App.

6. **One supervisor, global awareness.** A single PM instance for everything, all state
   under `~/.powdermonkey/` (one plan store, one server, one tmux socket). The point is
   global awareness: PM sees every repo and every running session at once, so it can
   reason about **shared constraints** — cloud concurrency and budget especially (five
   agents on one repo plus five on another is ten against your cap). A blunt
   `pkill -f index.ts` is never the move; there's one instance and one tmux socket.

## Prior art (what validated the shape)

- **Linear** structures planning as `Initiative → Project → Milestone → Issue`, with
  issues belonging to teams/projects and **not tied to a repo** — the repo connects to
  the *issue* via a git branch/PR. That's exactly our split: a repo-agnostic planning
  spine (Project → Theme), with the repo keyed to the Task. Our **Theme ≈ Linear's
  Milestone** (a stage/area within a project).
- **OpenAI Codex** (cloud agent) calls a repository an **Environment**, and a Task runs
  in exactly one. That's our **Task → one Repo**.
- **GitHub** is the contrast we *didn't* take: repo-centric (`org → repo → issues /
  milestones`), where a milestone belongs to one repo. We deliberately let a Theme span
  repos instead, for cross-cutting work.

So PowderMonkey is roughly **Linear's repo-agnostic planning spine + Codex's
repo-as-environment execution**, joined at the Task — collapsed to a solo, single-repo-
per-task, single-supervisor shape.

## Where it meets the runtime

- A plan is authored as a nested id-less tree (`projects → themes → tasks → phases`) via
  `POST /plan`; the loader stamps each task's `repo_id` to the default repo, and the
  operator re-targets per task.
- Dispatch / start-local resolve a task's repo, ensure its cache clone, and run there.
- Reconciliation reads `PM-Phase:` / `PM-Task:` trailers off `main` to mark phases done.
  *(Still single-repo today — scanning every repo's `main` is the remaining step to make
  it fully multi-repo.)*

## Open questions

- Extend the repo filter to the Active / Archive panes (today it scopes the Backlog).
- A per-task repo picker in authoring (today: `PATCH` a task's `repoId`; it defaults to
  the first repo).
- Make reconciliation multi-repo (scan each registered repo's `main`).
