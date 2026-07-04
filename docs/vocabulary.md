# Vocabulary

The one language PowderMonkey uses for the work, and the choices behind it. Small on
purpose. This is the canonical reference; `design.md` carries a shorter summary.

PowderMonkey is **solo operator, single supervisor** — one global instance, all state
under `~/.powdermonkey/`. There is no "workspace" or "project" entity. The work is
planned once, globally, and you *look* at slices of it through Windows.

## The model

```
PLANNING  (repo-agnostic — a goal can span repos)
  Goal ─→ Milestone ─→ Task ─→ Phase        (run as Sessions)
                        │
                        └─ targets exactly one ─→ Repo   (its environment)

REPOS     a flat, global list of GitHub repos (yours, public, or forks)

WINDOWS   like Firefox windows: a set of repo "tabs" you look at together.
          Usually unnamed and disposable — the working set itself is the
          "project" in your head. Session-restored on launch.

GLOBAL    always-on chrome above every window: agents running, usage/limits.
```

Three concerns, kept separate:

- **Planning — *what* you're building.** `Goal → Milestone → Task → Phase`. Repo-agnostic
  above the task: a Goal like "add this linter to three repos" is one goal with tasks in
  three repos.
- **Repos — *where* it runs.** A flat global list of GitHub repos. Only the **Task** pins
  one, because a dispatch is one environment (see Decisions).
- **Windows — *how you look*.** A frontend view over the global plan, scoped to a set of
  repos. Not part of the hierarchy.

## The terms

### Goal
The top of the plan tree: a long-term objective. **A root** — no parent. **Repo-agnostic**:
its work can land across several repos. May declare a **default repo — or a group of
repos** — that its tasks inherit (see Task). Id chip `g`.

### Milestone
A coherent grouping of tasks toward a goal — a checkpoint, an area, a chapter.
**Repo-agnostic**: a milestone can hold tasks across different repos. May also declare a
**default repo or group**, overriding the goal's for tasks under it. Id chip `m`.

### Task
A unit of dispatchable work. **Targets exactly one Repo** — its environment. Id chip `t`.

**Kind (`task` | `bug` | `spike`).** What flavour of work it is — purely descriptive
(it colors the card and sets authoring expectations), never behaviour: dispatch,
reconciliation, and progress are identical across kinds.

- **task** — the default: planned, build-shaped work.
- **bug** — something is wrong and needs fixing.
- **spike** — a timeboxed investigation whose deliverable is understanding.

Kinds deliberately do **not** template phases. Bugs and spikes are **discovery-first**:
what the work actually is emerges from doing it, so it can't be pre-canned into a
checklist at authoring time. Such a task usually starts with **few or no phases** and
accrues them — hand-authored, or co-pilot-proposed — as the work is understood. (This is
also why a worker's follow-up hand-back is authored as a phase-less `bug`.)

**Description vs. phases.** A task may carry a free-form **description** — the *context*:
why it exists, what's known, where it was seen. Phases stay **pure work** — discrete,
completable steps, the grain progress is measured at. Narrative goes in the description,
never smuggled into phase names; a phase you can't complete isn't a phase.

A task **inherits its default repo(s)** from its milestone, else its goal — so a goal
scoped to a repo group pre-fills every task under it. Authoring still offers a
**multi-select repo picker** (pre-filled from the inherited default, freely overridden):
pick N repos and PowderMonkey **fans out one task per repo**, all sharing the
milestone/goal. This is how "add the linter to three repos" is authored once — set the
goal's default to those three repos, and each new task fans out across them — not copied
three times.

### Phase
An author-defined sub-step within a Task. **The grain at which progress is measured**
(reconciliation marks phases done from `PM-Phase:` commit trailers on `main`). Id chip `#`.
**Pure work only**: a phase is a discrete, completable step — context and narrative belong
in the task's description. Discovery-first tasks (bugs, spikes) legitimately start with
none and gain phases as the work is understood.

### Task comment
A one-liner muttered onto a Task — the task's **diary**. Typed straight into the card
(Enter appends, auto-timestamped); after capture a line is an ordinary row — click it to
edit in place (fix the typo), × to archive it (the soft delete every entity uses). Two
voices, recorded in `author`: the **operator** (the card's composer) and the
**supervisor** (via the API, rendered with the robot glyph). Comments are capture, not
documentation — no title, no fields, no formatting — and they never affect progress. The
supervisor reads a task's diary as intent/mood context ("operator was unsure here")
before authoring proposals about it.

### Repo
A **GitHub git repo** (`owner/repo`, a default branch), in a **flat global list** you
configure. **Cloud-first**: the repo of record is on GitHub. PowderMonkey never treats it
as a local checkout you browse — when it needs a working tree (a local session's worktree,
or a `claude --remote` cwd) it clones a **transient cache** under
`~/.powdermonkey/repos/<owner>/<repo>` on demand. A Repo is *not* a level in the plan
spine; it's what a Task points at. Id chip `r`.

**Adding repos.** A Blender-style picker (see Windows) sources them three ways:

- **Yours** — `gh repo list --json nameWithOwner,description,visibility`.
- **Public search** — `gh search repos <query> --json fullName,description,stargazersCount`.
- **Fork-first** — adding a repo you can't push to runs `gh repo fork <slug> --clone=false`
  and registers *your fork* as the target (with `upstream` recorded). Cloud dispatch needs
  push access, so fork-first is what makes driving someone else's public repo actually work.

**Identity (supervisor-assigned).** Each repo gets a visual identity so cross-repo work is
scannable at a glance:

- **Color** — a stable hue hashed from the slug, resolved to a swatch in the *active*
  theme's palette (re-skins on theme change, never clashes). Stored as a seed on the repo
  row; operator-overridable.
- **Icon** — resolved once per repo, lazily on the first icon request: try the repo's
  homepage favicon (`gh repo view --json homepageUrl` → `/favicon.ico`), else the owner
  avatar (`https://github.com/<owner>.png`, always available). Cached under
  `~/.powdermonkey/repos/.icons/<owner>/<name>.png` — next to the cache clones, not
  inside them, so a pre-clone icon never makes `git clone` fail on a non-empty dir —
  and served at `/repos/:id/icon`.

Task cards, session panes, and the Windows rail all render a repo's color + icon.

### Session
One run of work, independent of the hierarchy: `local` (a git worktree) or `remote`
(`claude --remote`). A session completes phases in exactly one repo (its task's repo).
Progress is read off that repo's `main`, never self-reported.

### Window
A saved **view**: a panel arrangement (a dockview split) **plus the set of repos it shows**.
Modeled on **Firefox windows** — a window is a series of repo "tabs," it's usually
**unnamed and disposable**, and the collection itself is what reads as a "project" in your
head. You open them freely, throw repos in, and switch between them for different modes of
work. A **pure frontend concern** — not part of the plan hierarchy.

- **`Ctrl+N`** opens a new window with a **Blender-style picker**: your `gh` repos, a
  public-repo search, and a fork-first toggle. Select repos to populate the window.
- **Session restore is first-class.** On launch, every open window comes back — its layout
  *and* its repo tabs. This extends the layout persistence already in place
  (`App.tsx` writes `api.toJSON()` on every dock change).
- Naming is optional; an unnamed window is identified by its repo set, exactly like a
  browser window.

Windows and Goals are the two things that feel like "a project," and they're deliberately
different layers: a **Goal** is a defined body of *work* (tracked, reconciled); a **Window**
is a *viewing context* (which repos you're staring at now). A window can watch several
goals; a goal can be watched from several windows.

### Global status bar
Always-on chrome **above every window** — supervisor-wide, not window-scoped, because one
supervisor sees everything at once. Surfaces the **shared constraints**:

- **Agents running** — live count of active sessions across all repos.
- **Claude usage / limits** — remaining budget and rate/concurrency headroom, as the data
  is available.

The point is that five agents on one repo plus five on another is ten against your cap; the
global bar is where that stays visible regardless of which window you're in.

### Scratchpad
Free-form operator notes, at two scopes with different lifetimes:

- **Per-window (local)** — each window has its own scratchpad for the throwaway thinking of
  *that* working context. Lives in the window's session-restore state (device-local),
  disposable with the window.
- **Global** — one durable, server-side scratchpad (today's single note), the standing
  brain-dump that's always present regardless of window and syncs across devices.

Local is "this context, right now"; global is the notebook you never lose.

### Supervisor
There is exactly one supervisor **process** — global awareness is the point (Decision 6): it
must see every repo and session to reason about the shared concurrency/budget cap. What can
vary is the supervisor **pane** you drive it through:

- **Global pane (default)** — one conversation that drives any repo and sees everything.
- **Per-window pane (opt-in, deferred)** — a supervisor conversation scoped to that window's
  repos. Not free: a scoped supervisor is another running agent against the same cap the
  global bar tracks. Value unproven, so it's not in v1.

## Id chips

`g` goal · `m` milestone · `t` task · `#` phase · `r` repo. So `g3` is a goal, `m7` a
milestone, `t41` a task, `#137` a phase, `r4` a repo.

## Decisions (and why)

1. **No rename.** An earlier draft renamed Goal→Project and Milestone→Theme. Cut: it's pure
   churn with zero multi-repo value, and bundling it is part of why the first
   implementation got reverted. Goal / Milestone / Task / Phase stay.

2. **No Project (or Workspace) entity.** The grouping people reach for — "my side projects,"
   "this linter push" — is served two ways without a new plan level: a cross-repo **Goal**
   for the *work*, and a **Window** for the *view*. Solo operator + single supervisor means
   there's nothing above the goal to model.

3. **Goals and Milestones are repo-agnostic; a Task targets exactly one Repo.** A coding
   session is one environment — a cloud agent clones one repo. So the repo is forced to the
   **Task** (the dispatch atom), and everything above it stays free to span repos. Goals and
   milestones may declare a **default repo or group** that cascades down (milestone overrides
   goal), pre-filling the task's repo picker; the task can still override. Only tasks sharing
   a repo can be dispatched in one session (the UI blocks a cross-repo multi-select; the API
   rejects it). Cross-repo work is authored via the task fan-out.

4. **Windows are Firefox windows, not Layouts.** A *Layout* implies a re-applyable template;
   people rarely want templates. A window is a live, disposable view you keep only as long
   as it's useful, and it bundles both its panel arrangement **and** which repos it shows.
   Session-restored, usually unnamed, lives in an always-open left rail.

5. **Cloud-first repos.** A repo is its GitHub identity (`owner/repo`), not a local checkout.
   PowderMonkey keeps only transient cache clones under `~/.powdermonkey/`, cloned on demand
   and never browsed by hand. Cloud dispatch (`claude --remote`) needs no local auth — the
   sandbox clones via the Claude GitHub App (which must be installed on each target repo, or
   a fork you own).

6. **One supervisor, global awareness.** A single instance for everything, all state under
   `~/.powdermonkey/`. The payoff is that PowderMonkey sees every repo and every running
   session at once, so it can reason about **shared constraints** — cloud concurrency and
   budget especially — and surface them in the global status bar.

## Prior art (what validated the shape)

- **Linear** plans as `Initiative → Project → Milestone → Issue`, with issues **not tied to
  a repo** — the repo connects to the *issue* via a git branch/PR. That's our split: a
  repo-agnostic planning spine with the repo keyed to the Task.
- **OpenAI Codex** (cloud agent) calls a repository an **Environment**, and a task runs in
  exactly one. That's our **Task → one Repo**.
- **Firefox** windows: an unnamed set of tabs that reads as a project by context, restored
  across restarts. That's our **Window**.
- **GitHub** is the contrast we *didn't* take: repo-centric (`org → repo → issues /
  milestones`), where a milestone belongs to one repo. We let a Goal/Milestone span repos
  instead, for cross-cutting work like the linter push.

## Where it meets the runtime

- A plan is authored as a nested id-less tree (`goals → milestones → tasks → phases`) via
  `POST /plan`; each task carries a `repo_id`. The task fan-out expands a multi-repo pick
  into one task per repo at load time.
- **Dispatch / start-local** resolve the task's repo, ensure its cache clone under
  `~/.powdermonkey/repos/<slug>`, and run there — the dispatch PTY's `cwd` is that clone, so
  `claude --remote` infers the right GitHub repo from its remote (no repo flag needed).
- **Local worktree sessions** (in scope for v1) cut `pm/task-<id>` from the task's repo cache
  clone rather than the supervisor's own repo, so `start-local` works on any registered repo.
- **Reconciliation** loops the registered repos, `git fetch`es each cache clone, and scans
  its `main` for `PM-Phase:` / `PM-Task:` trailers. (Today it scans a single repo — the
  loop is the main new piece of plumbing.)
- **PR watching** polls each registered repo instead of one cached global slug.
- **Windows are per-device** — session-restore state lives in the browser/desktop client, not
  synced across machines (for now).

## Migration

On upgrade, create a Repo for the supervisor's own repo (`zmaril/powdermonkey`) and attach
every existing goal's tasks to it. No data loss; PowderMonkey-on-itself becomes "a window
showing one repo."

## Open questions

- **Usage/limits data source** — what does the `claude` CLI actually expose for
  budget/concurrency, versus what has to be inferred from live session counts? **Needs a
  spike** before the global status bar's usage readout can be specified.
- Icon resolution edge cases — private repos with no homepage (owner avatar covers it), and
  refresh cadence for a repo whose avatar/favicon later changes.
- **Per-window supervisor pane** — worth the extra running agent (against the cap) for
  repo-scoped focus, or is the global pane always enough? Deferred until the value is clear.
