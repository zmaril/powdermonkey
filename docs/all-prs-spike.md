# Spike: show GitHub PRs (whether we're working on them or not)

> PM task 107x. Goal: decide how PowderMonkey should surface **all open PRs on a
> repo** — not just the `pm/task-*` PRs our own cloud workers open — so the
> operator sees external/human PRs (Dependabot, collaborators, their own hand-cut
> branches) in-app alongside PM-driven work, and can act on them (review / adopt /
> dispatch) without bouncing to github.com.
>
> Three phases: **Survey** what `github-watch` pulls today and how to widen it ·
> **Sketch** where all-PRs render and what's actionable · **Recommend** a data
> model, sync cadence, dedup story, and a first slice.

## TL;DR

- **The widening is mostly a subtraction, not an addition.** `github-watch.ts`
  already runs `pullRequests(first:100, orderBy:{UPDATED_AT})` — it fetches
  *every* PR on the repo each tick. It then **throws away** the ones it can't tie
  to a task (`resolveTaskId(...) === null → continue`). "Show all PRs" is largely:
  stop skipping those rows, keep them as **external** PRs (no `taskId`), and add
  the one field we don't fetch yet — `author`.
- **The review surface already works for any PR.** `pr-review.ts` /
  `openReview(pr.number)` is keyed by **PR number**, not by task — it does
  `gh api repos/{o}/{r}/pulls/{n}` with no PM assumptions. So "review an external
  PR in-app" is essentially free today; the only missing piece is a place to *see*
  the external PR and click Review.
- **Dedup is a non-problem.** The `pull_requests` table is keyed by PR
  `number` (primary key). A PR is one row whether it's ours or theirs; "adopting"
  an external PR is just setting its `taskId`. There is no second store to
  reconcile.
- **The one real hazard is the mutating subscribers.** The auto-rebase subscriber
  posts `@claude rebase` comments and the merge subscriber triggers `reconcile`.
  Those must **never** fire on a stranger's PR. External PRs have to be persisted
  for display **without** flowing through the `pr.*` bus side-effects (or those
  handlers must hard-gate on `taskId != null`).
- **There is no "issues" pane to sit next to.** The brief says "a pane/lens next
  to issues," but PowderMonkey has **no GitHub-issues surface at all** today (grep:
  zero). The natural home is a **new top-level "PRs" pane** beside Sessions/Tasks,
  reusing the existing `PrRow`.

---

## Phase 1 — Survey: what `github-watch` pulls today, and how to widen it

### What the watcher fetches now

`src/server/github-watch.ts` holds one GraphQL query (`GQL`, lines 49–60) run
every `PM_GITHUB_WATCH_INTERVAL_MS` (default **10s**) against the single repo from
`resolveRepo()` (`$PM_GITHUB_REPO`, else `gh repo view`):

```graphql
repository(owner,name){
  pullRequests(first:100, orderBy:{field:UPDATED_AT, direction:DESC}){
    nodes{
      number title url state isDraft merged mergeable updatedAt headRefName
      checks:  commits(last:1){ nodes{ commit{ statusCheckRollup{ state } } } }
      history: commits(first:100){ nodes{ commit{ messageBody } } }   # trailer scan
      comments(last:30){ nodes{ databaseId url body updatedAt } }     # status/followups
    }
  }
}
```

So it already pulls **the 100 most-recently-updated PRs of any state** — open,
closed, and merged. Per PR it collects exactly the brief's wish-list **except
`author`**:

| Brief field | Fetched today? | Where |
|---|---|---|
| `number`     | ✅ | `n.number` |
| `state`      | ✅ | `n.state` (OPEN/CLOSED/MERGED) |
| `checks`     | ✅ | `statusCheckRollup.state` on the last commit |
| `draft`      | ✅ | `n.isDraft` |
| `updatedAt`  | ✅ | `n.updatedAt` |
| **`author`** | ❌ | **not selected** — the miss |

Plus `title`, `url`, `mergeable`, `merged`, `headRefName`, and two heavy
sub-selections used only for PM bookkeeping: `history` (100 commit bodies, scanned
for `PM-Task:` / `PM-Phase:` trailers) and `comments` (last 30, parsed for the
`<!-- pm:status -->` / `<!-- pm:followup -->` markers).

### Where the PM-only filter actually is

The query is repo-wide; the narrowing happens **in the loop body**, per node
(`fetchCloudPrs`, lines 93–98):

```ts
const taskId = await resolveTaskId(n.headRefName ?? "", commitText);
if (taskId == null) continue; // can't tie this PR to a task — skip it
```

`resolveTaskId` (lines 306–312) tries, in order:
1. **Branch name** — `^pm/task-(\d+)` (e.g. `pm/task-166-archive-…` → 166).
2. **`PM-Task:` trailer** in any commit body → that task id.
3. **`PM-Phase:` trailer** → DB lookup (`phases.taskId`) → its task.

Anything a human opens — `main`-based branches, `dependabot/…`, a collaborator's
`feature/x` — matches none of these, so it's dropped on the floor. **The data is
already in hand every tick; we just `continue` past it.**

Downstream, everything assumes that filter held:
- `CloudPr.taskId` is a non-optional `number` (`events.ts`).
- `pull_requests.taskId` is `integer(...).notNull()` (`schema.ts:214`).
- `upsertPrState` writes a `taskId` for every row; `listPrs`/`rowToCloudPr`
  reconstruct one.
- The UI keys PRs **by task** (`plan-data.ts` builds `prByTask`, a
  `Map<taskId, CloudPr>`; `PrRow` renders inside a worker card).

### How to widen it to ALL open PRs per repo

Four concrete moves, smallest-first:

1. **Add the missing field.** Extend the node selection with
   `author{ login } authorAssociation` (and, cheaply, `createdAt`,
   `reviewDecision`, `labels(first:10){nodes{name color}}` if we want richer
   cards). `author` can be `null` for a deleted/ghost account — handle it.
2. **Stop skipping unresolved PRs.** Replace the `continue` with: keep the node,
   set `taskId = null`, and **skip the heavy enrichment** (no trailer scan needed,
   no PM status/followup parsing — a stranger's PR has none). This turns the miss
   into an *external* PR record.
3. **Scope to open (for the board).** For an "open PRs" lens, add
   `states:[OPEN]` to the `pullRequests(...)` args (or filter client-side). The
   existing PM lifecycle logic still wants CLOSED/MERGED transitions, so this is a
   *view* decision, not a fetch-wide one — see the two-tier note below.
4. **Mind the cost.** `first:100` with `history(first:100)` + `comments(last:30)`
   on *every* node is already the expensive part, and it's **pure waste for
   external PRs** (100 PRs × 100 commit bodies each, none of which we scan). The
   honest widening splits the fetch into two tiers:
   - **Cheap list** — scalars + `author` + `checks` for *all* open PRs. This is
     what the new board needs.
   - **Heavy enrich** — the existing `history`/`comments` sub-selections, run
     **only for PM-linked PRs** (branch/trailer match), because only those carry
     trailers, status comments, and follow-ups.
   GraphQL can't conditionally sub-select, so "two tiers" = either two queries, or
   one list query + a second enrich query filtered to `pm/task-*` head refs.

### Cost / budget note

The header comment already budgets the current poll at "~1 point of a 5000/hr
budget" at 10s. Adding `author` to the existing query is free (same node, one more
scalar). The real cost lever is the `history(first:100)` fan-out; keeping that
scoped to PM PRs (a handful) rather than all 100 nodes is what keeps the widened
poll cheap. Open-only (`states:[OPEN]`) also shrinks the node count on any repo
with a long closed/merged tail.

### Multi-repo caveat ("per repo")

The brief says "all open PRs **per repo**." Today `resolveRepo()` resolves a
**single** repo (env or `gh repo view`), even though the schema already has a
`repos` table and `goals`/`milestones`/`tasks` carry a `repoId`. A true per-repo
all-PRs view means fanning the fetch out over the `repos` table (one GraphQL call
per repo) and tagging each PR row with its repo. That's a larger lift than the
single-repo widening and is called out as a **later slice**, not the first one.

---

## Phase 2 — Sketch the view: where all-PRs render, and what's actionable

### There is no "issues" surface to sit beside

The brief says "a pane/lens next to issues." Worth stating plainly: **PowderMonkey
has no GitHub-issues surface today.** A grep for `issue`/`Issue` across `src/`
turns up exactly one hit — `IssueComment databaseId` in `events.ts`, i.e. PR
*comments*, not issues. The top-level panes (from `TopBar.tsx`) are: **Sessions,
Tasks, Shell, Browser, Scratch, Settings, About, Help.** So "next to issues" is
aspirational; the real question is which *existing* surface all-PRs belongs on, or
whether it's a new one.

### Where PRs render today

Only one place: **inside worker cards on the Sessions pane.** `plan-data.ts`
folds `cloudPrs` into a `Map<taskId, CloudPr>` (`prByTask`); `grouping.workerPrs`
de-dupes the PRs across a session's tasks; `PrRow.tsx` renders each — a CI/conflict
status dot, the `#number` link, the title, a **Review** link (`openReview`), and
the worker's agent-state chip + narrative. The whole path is **task-keyed**: no
task ⇒ no home for the PR.

### Three candidate homes (and the pick)

| Option | Fit | Verdict |
|---|---|---|
| **A. New "PRs" pane** (PaneButton beside Sessions/Tasks) | A repo-wide board of open PRs, PM + external, grouped. Reuses `PrRow`. | ✅ **Pick.** Clean home; matches the mental model ("all PRs on the repo"). |
| **B. A lens/filter on Sessions** | Sessions is *session*-centric — one card per live worker. External PRs have **no session**, so they'd be orphans crammed into a session view. | ❌ Poor fit. |
| **C. A section on Tasks** | Tasks is the *plan* (Goals→…→Tasks). External PRs aren't tasks; they'd dilute the plan. | ❌ Poor fit (until/unless "adopt" turns one into a task). |

**Pick A: a new top-level "PRs" pane.** It reads `pullRequestsCollection`
directly (already live-synced to the browser — `collections.ts`), needs no
task-keying, and reuses `PrRow` almost verbatim. Sessions keeps showing *our*
PRs in worker context; the PRs pane is the repo-wide roll-up.

### Sketch of the pane

Two groups, because the operator cares about the ours/theirs split more than
anything else:

```
┌ PRs ────────────────────────────────────────────── [⟳ synced 4s ago] ┐
│                                                                        │
│  Ours (PM tasks)                                                       │
│   ● #166  archive merged sessions        working ▸   t166   [Review]   │
│   ● #170  native windows repo-sets       blocked ▸   t170   [Review]   │
│                                                                        │
│  Theirs (external)                                                     │
│   ● #171  Bump vite 5→6            dependabot[bot]  draft   [Review]    │
│   ● #172  fix: typo in README         @acollab              [Review]   │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

- **Status dot** — reuse `prDot()` verbatim (CI + conflicts + merged, GitHub-style).
- **`#number` + title** — as `PrRow` does now.
- **Review** — reuse `openReview(pr.number, pr.title)` as-is (see below).

### Marking PM-driven vs external

The signal is already in the row: **`taskId` presence.**

- **Ours (PM):** `taskId != null`. Show the task chip (`t166`, links to the card),
  the agent-state badge, and the agent narrative — exactly `PrRow` today.
- **Theirs (external):** `taskId == null`. Swap the agent chip for the **author**
  (`author.login` + a bot/human/collaborator hint from `authorAssociation`), and
  drop the narrative (there's no PM status comment to show). A small **"external"**
  or bot glyph reads at a glance.

No new persisted flag needed — `taskId == null` *is* the discriminator. (An
`authorAssociation` of `OWNER`/`MEMBER`/`COLLABORATOR` vs `NONE`/`CONTRIBUTOR`
lets us further tint "trusted collaborator" vs "outside contributor" if wanted.)

### Is an external PR actionable? Yes — three tiers, mostly already built

1. **Open review — free today.** `openReview(number, title)` → `ReviewPane` →
   `GET /prs/:number/review` → `pr-review.ts` → `gh api repos/{o}/{r}/pulls/{n}`.
   **None of that path is PM-specific** — it takes a PR *number*. So the Review
   button works on an external PR with zero new server code. This is the single
   biggest reason the spike is cheap: the expensive surface (diff render, inline
   comments, batched review verdict) is already number-keyed.
2. **Adopt — small new action.** "Adopt" ties an external PR to PM: either create
   a task *from* the PR (title/body seed a `create task` proposal) or link the PR
   to an existing task by writing `taskId` onto its `pull_requests` row. Adoption
   is what moves a PR from **Theirs → Ours** and, from that point, lets the normal
   PM machinery (task card, reconcile-on-merge) engage. Because the store is keyed
   by number, adoption is a single `UPDATE … SET task_id` — no row copy, no dedup.
3. **Dispatch / `@claude` — exists, but gate it.** `askClaude(number, msg)` already
   posts an `@claude …` comment on any PR (it's how auto-rebase talks to live
   workers). We *could* dispatch a cloud worker at an external PR (e.g. "address the
   review comments"). **But** `@claude`-ing a human contributor's PR is a different
   social contract than nudging our own worker — so this must be an explicit,
   confirmed operator action, never automatic, and ideally only offered on PRs we
   own or have adopted. (This is the same hazard the data-model section flags for
   the *auto*-rebase subscriber.)

**Actionability summary:** Review = free now · Adopt = small · Dispatch = exists
but must be gated behind an explicit click and, by default, scoped to our/adopted
PRs.

---

## Phase 3 — Recommendation, rough design, and the first slice

### Recommendation

**Widen the existing pipeline in place; don't build a parallel one.** One repo,
one poll, one store, keyed by PR number. External PRs become rows with a null
`taskId` and empty PM enrichment; the existing `PrRow` renders them in a new PRs
pane. Reviewing works day one. Adopt (set `taskId`) and gated Dispatch are
follow-ups. The only genuinely new *care* is keeping external PRs out of the
mutating side-effects.

### Data model

Keep the **single `pull_requests` table**, keyed by `number` — this is what makes
dedup a non-issue. Changes:

| Change | Why |
|---|---|
| `taskId` → **nullable** (`integer`, drop `.notNull()`) | External PRs have no task. `null` *is* the "external" discriminator (Phase 2). |
| add `author` (`text`, nullable) | The one field the brief wants that we don't store. `null` for ghost/deleted accounts. |
| add `authorAssociation` (`text`, nullable) — optional | Tint bot / collaborator / outside contributor. |
| add `reviewDecision` (`text`, nullable) — optional | `APPROVED` / `CHANGES_REQUESTED` / `REVIEW_REQUIRED` for a review-state chip. |
| (later, multi-repo) add `repoId` (`integer` FK → `repos`) | Only when the fetch fans out per repo. Single-repo v1 doesn't need it. |

`CloudPr.taskId` widens to `number | null` (`events.ts`), and `rowToCloudPr` /
`upsertPrState` stop assuming a task. A Drizzle migration under `drizzle/` alters
`task_id` nullable and adds the columns; PGlite applies it on boot like the others.

**Dedup vs the existing task-PR store — explicitly:** there is no separate store.
The task-PR data *is* `pull_requests`, primary-keyed by `number`. An external PR
and a PM PR can never collide because a given `number` is exactly one PR on GitHub
→ exactly one row. "Adopt" mutates that one row's `taskId`; it never inserts a
duplicate. So the classic "two lists to reconcile" problem doesn't arise.

### Sync cadence — two tiers

The mutating machinery (auto-rebase asks, follow-up ingest, reconcile-on-merge)
must stay **exactly as urgent and as scoped as today**; the external roll-up can be
lazier and must be side-effect-free.

- **Tier 1 — PM PRs, 10s, full enrichment, drives the bus.** The current query,
  narrowed to PM PRs where practical (`headRefName` starting `pm/task-`, plus the
  trailer fallback), keeps `history`/`comments` and keeps emitting `pr.*` events.
  Unchanged behaviour.
- **Tier 2 — all open PRs, slower (~30–60s), scalars + `author` + `checks` only,
  NO bus events.** A cheap `pullRequests(states:[OPEN], first:100)` list that
  upserts rows for display and **does not** emit `pr.opened/updated/...`. External
  rows are written straight to the store for the UI; they never reach
  `maybeAskRebase` / `ingestFollowups` / `scheduleReconcile`.

> **The hazard, restated as a hard rule:** external PRs must not flow through the
> `pr.*` subscribers. Auto-rebase would post `@claude rebase` on a stranger's PR;
> reconcile-on-merge is meaningless for a non-task PR. Enforce by construction —
> Tier 2 writes rows without emitting events — and belt-and-braces by guarding
> `maybeAskRebase` / `enrich` / `ingest` / `scheduleReconcile` on `taskId != null`.

A pragmatic **v1 shortcut** that avoids two queries: keep the *single* existing
query, add `author`, and just stop `continue`-ing past unresolved PRs — persist
them with `taskId=null` and skip enrichment. Accept that `history(first:100)` still
runs on external nodes (wasteful but correct on a small repo), and **do not emit
bus events for `taskId==null` PRs**. This is the least code to a working board;
tighten to true two-tier only if the poll cost bites.

### The first slice to build

Ship the smallest thing that puts external open PRs in front of the operator with
a working Review button. Explicitly **out of scope for slice 1:** Adopt, Dispatch,
multi-repo, `reviewDecision`.

1. **Schema + migration** — `task_id` nullable; add `author` (and
   `authorAssociation`) to `pull_requests`; Drizzle migration in `drizzle/`.
2. **Server fetch** — add `author{login} authorAssociation` to the GQL node;
   replace the `if (taskId == null) continue;` with "keep it, `taskId=null`, skip
   enrichment"; widen `CloudPr.taskId` to `number | null`; carry `author` through
   `CloudPr` / `upsertPrState` / `rowToCloudPr`.
3. **No new side-effects** — in `tick`, emit `pr.*` events **only** for
   `taskId != null` PRs (external rows are upserted for the UI but never emitted).
   Add `taskId != null` guards to the subscribers as defence-in-depth.
4. **UI — new PRs pane** — a `PaneButton "PRs"` in `TopBar`; a pane reading
   `pullRequestsCollection`, filtered to open, grouped **Ours** (`taskId != null`)
   / **Theirs** (`taskId == null`), each row via `PrRow` (external variant shows
   `author` instead of the agent chip/narrative). Review reuses `openReview`.
5. **Verify** — per CLAUDE.md, render it: build the web bundle, seed a couple of
   `pull_requests` rows (one PM, one external), screenshot the new pane, confirm
   Review opens an external PR's diff.

**Slice 2+ (follow-ups):** Adopt (set `taskId` / seed a task-from-PR proposal),
gated Dispatch (`@claude` behind an explicit confirm, our/adopted PRs only),
`reviewDecision` chip, and multi-repo fan-out over the `repos` table (`repoId` on
the row).

### Open questions for the operator

- **"Per repo" now, or single-repo first?** Single-repo is the cheap first slice;
  multi-repo (fan out over `repos`) is a meaningfully bigger lift. Recommend
  single-repo v1 unless you're already juggling PRs across repos day-to-day.
- **Do you want Dispatch (`@claude` a PR) at all for *external* PRs**, or should
  that action be hard-limited to our/adopted PRs? Default proposed: our/adopted
  only, explicit confirm.
- **Should closed/merged external PRs ever show** (a "recently merged" tail), or is
  the board strictly open PRs? Default proposed: open only.
