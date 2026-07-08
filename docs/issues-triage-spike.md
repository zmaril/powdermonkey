# Spike: import / view GitHub issues to triage + dispatch

> Goal: decide how PowderMonkey should pull a repo's **open GitHub issues** into a
> viewing surface where the operator can triage them and **dispatch a worker** at one —
> turning "there's an issue" into "there's a task, and it's running." The brief asked to
> survey how the existing PR watcher works, sketch the issue → task path (reusing the
> follow-up / proposal machinery), decide read-only vs two-way, and pick a first slice.

This doc is built up across the spike's three phases: **Survey** (below), **Issue → task**,
then the **Recommendation + rough design + first slice**.

## TL;DR

- **Build read-only issues triage that mirrors the PR watcher end-to-end.** Almost every
  moving part already exists; the net-new code is small.
- **Server** — a second instance of the `github-watch` pattern: one `gh api graphql` poll
  of `Repository.issues` per repo, `diff → upsert` into a new **`github_issues`** cache
  table (+ a small triage ledger), reusing the existing loop, bus, and `gh` seam. Issues
  change slower than active PRs, so poll on a slower cadence than the 10s PR tick.
- **UI** — an **Issues list pane** in the dock (a triage inbox), backed by a **one-line
  live-synced TanStack DB collection** over the existing `/sync` WebSocket, exactly like
  `pull_requests`. No client polling, no bespoke fetch.
- **Triage reuses the proposal path.** An issue is (title + body) → a pending `create
  task` proposal (a thin `proposeIssueTriage` beside `proposeFollowup`) → the **existing**
  decision queue → the **existing** `POST /tasks/:id/dispatch`. The only genuinely new
  logic is **repo binding** (set the task's `repoId` from the issue's repo) and an
  issue-identity **dedup ledger**.
- **Read-only is the right cut.** No writes to GitHub: the dispatched worker's PR
  `Closes #N`, and **GitHub auto-closes the issue on merge** — the close is free. The only
  two-way write worth anything (a backlink comment) is a small additive follow-on.
- **First slice** (bottom of this doc): the thin vertical — poll + cache table + live
  collection + Issues pane + one "Triage" button — reusing proposals and dispatch entirely.

## Survey

### How `github-watch` pulls PRs today

`src/server/github-watch.ts` is *the one loop*. It polls GitHub on a timer and turns
diffs into typed events that independent subscribers react to. The shape worth copying:

- **Transport — one `gh` seam.** Everything goes through `gh.ts`'s `gh([...])`, which
  shells out to the operator's already-authed GitHub CLI and never throws (a missing
  `gh` / no auth / network blip comes back as `{ ok: false }`). PowderMonkey is a
  localhost tool with no public endpoint, so there's no webhook to hang off — polling
  over `gh` auth is the whole strategy. `resolveRepo()` (from `$PM_GITHUB_REPO` or
  `gh repo view`) names the repo, cached after first hit. (`github-watch.ts:67`,
  `gh.ts:20`, `gh.ts:33`.)
- **One GraphQL query per tick.** `fetchCloudPrs()` fires a single
  `gh api graphql` call — `pullRequests(first:100, orderBy:{UPDATED_AT, DESC})` with
  `number title url state isDraft merged mergeable updatedAt headRefName`, the last
  commit's `statusCheckRollup`, commit `messageBody`s (for trailers), and the last 30
  comments. Returns `null` on any failure so the caller leaves last-known state
  untouched; an empty array means "fetched fine, no matching PRs." (`github-watch.ts:49`,
  `:67`.)
- **Cost.** "Realtime" is efficient polling: a 10s poll (`PM_GITHUB_WATCH_INTERVAL_MS`,
  default `10_000`) costs ~1 point of a 5000/hr GraphQL budget and feels live. The
  comment at `github-watch.ts:26` spells out the division of truth: GitHub PR state is
  the lifecycle *clock*; commit trailers on `main` stay the *truth* for completion.
- **Diff, don't re-emit.** `sig(pr)` hashes only the fields we react to; `diffCloudPrs`
  (pure, tested) compares the previous tick's `Map<number, CloudPr>` to the fresh set
  and emits `pr.opened` / `pr.updated` / `pr.merged` / `pr.closed`. A first-seen PR is
  classified by its current state — which is how the **startup catch-up** (empty `prev`,
  `initial:true`) replays existing PRs without re-notifying. (`github-watch.ts:320`,
  `:334`, `:434`.)
- **Persist, then emit.** Each changed PR is upserted into the `pull_requests` table via
  `pr-store.ts` *before* events fire. That table is a deliberate mix of a **cache** of
  GitHub state (overwritten every tick) and a **ledger** of a side-effect we performed —
  `rebaseAskedAt`, which must survive restarts so we never re-ask the same conflict. The
  two write paths are kept separate: `upsertPrState` never touches the ledger column.
  (`pr-store.ts:61`, `schema.ts:214`.)
- **Event seam.** A tiny in-process typed bus (`events.ts`) fans each event out to
  independent subscribers registered in `registerSubscribers()`: keep `task.prUrl`
  current, **slurp follow-ups into proposals**, ask `@claude` to rebase a conflict,
  reconcile on merge. None know about each other; adding a reaction is one `bus.on(...)`.
  (`github-watch.ts:486`.)

The takeaway: **issue-watching is a second instance of this exact pattern** — a GraphQL
poll → diff → upsert-to-a-cache-table → (optionally) emit events. Almost everything
except the query string and the table columns is reusable prior art.

### What `gh` / GraphQL gives us for issues per repo

GitHub's GraphQL `Repository.issues` connection is the direct analog of the
`pullRequests` one already in use, and it hands us everything the brief named:

```graphql
query($owner:String!,$name:String!){
  repository(owner:$owner,name:$name){
    issues(first:100, states:[OPEN], orderBy:{field:UPDATED_AT, direction:DESC}){
      nodes{
        number title url state body
        author{ login }
        createdAt updatedAt
        labels(first:20){ nodes{ name color } }
        assignees(first:10){ nodes{ login } }
        comments{ totalCount }
        milestone{ title }
      }
    }
  }
}
```

- **Open issues, labels, author, updatedAt** — all present: `state` (`OPEN`/`CLOSED`,
  filterable with `states:[OPEN]`), `labels.nodes[].{name,color}`, `author.login`,
  `updatedAt`/`createdAt`. Plus `body` (for the triage view / task description),
  `assignees`, `comments.totalCount`, `milestone`.
- **GraphQL cleanly separates issues from PRs.** `Repository.issues` returns *only*
  issues — pull requests live in the separate `pullRequests` connection. This is the
  key reason to use GraphQL over `gh issue list` / REST `/issues`: the REST issues
  endpoint conflates the two (every PR is also an issue there), which we'd have to
  filter out. GraphQL gives us issues-only for free, and matches the transport the PR
  watcher already uses.
- **`gh` convenience alternative.** `gh issue list --json number,title,state,labels,author,updatedAt,body,url`
  is simpler to write and also excludes PRs, but the GraphQL path keeps us consistent
  with `fetchCloudPrs` (one `gh api graphql` seam, one diff shape) and lets us fetch
  issues and PRs side-by-side later. Recommend GraphQL for parity; `gh issue list` is a
  fine fallback if the query proves fiddly.
- **Cost is the same order** as the PR poll — one `issues(first:100)` page is ~1 point.
  Pagination past 100 open issues is a `pageInfo`/cursor loop if a repo ever needs it;
  most single-operator repos won't.
- **Caveat to confirm at build time:** the exact GraphQL field availability (e.g.
  `stateReason` on closed issues, `issueType` on orgs) should be checked against the
  live schema — but the fields above are long-stable and match what `fetchCloudPrs`
  already relies on.

### Where a viewing pane / lens would live

Two existing surfaces bracket the options, and the UI plumbing for a new one is small:

- **The dockview pane system** (the natural home for a *list lens*). Panes are
  registered in `src/web/app/layout.ts`: a `dockComponents` map (pane id → component)
  and a `PANE_TITLES` map, opened from `TopBar.tsx` via `openPane("...")` (a store
  action). Each pane is a thin `XxxPanel.tsx` wrapper around the real pane under
  `src/web/panes/`. Adding an **Issues** pane touches exactly: a `panes/issues/` pane
  component, an `IssuesPanel.tsx` wrapper, two lines in `layout.ts`, and one
  `<PaneButton label="Issues" onClick={() => openPane("issues")} />` in `TopBar.tsx`.
  (`layout.ts:18`, `:31`, `TopBar.tsx:72`.)
- **The Review overlay** (the model for a *single-item focus* surface). PR review is a
  full-window takeover (`ReviewOverlay` in `App.tsx`, `position:fixed; inset:0`) hosting
  its own dockview — because reviewing is a focused activity, not a parked tab (see
  `docs/pr-review.md`). An issue *reader* (render one issue's markdown body + comments)
  could reuse this overlay pattern later; triage itself doesn't need it.
- **Data flow is already live-sync, not fetch-and-poll.** The browser mirrors each
  server table as a **TanStack DB collection** synced over a `/sync` WebSocket from
  PGlite's `live.changes` (`collections.ts`). `pull_requests` is registered this way as
  `pullRequestsCollection` (keyed by `number`, `collections.ts:100`) and the UI reads it
  as a reactive live query — no client polling, no bespoke fetch. **A `github_issues`
  table registers identically** (`syncedCollection<GithubIssue>("github_issues", ...)`),
  so the Issues pane's list is a one-line collection registration plus a live query;
  writes still go through REST routes and stream back as deltas.

So the lens has a clear, cheap home: an **Issues list pane** in the dock (triage inbox),
backed by a live-synced cache table the server watcher fills — mirroring PRs end-to-end.

## Issue → task

### The reuse: an open issue is already a "proposed task" in disguise

The follow-up machinery (`src/server/followups.ts`) already solves the general problem
*"turn a one-line find into a task the operator approves before it joins the plan."* An
imported issue is the same shape — a title plus a body — so triage reuses that path
wholesale rather than inventing new machinery:

- `proposeFollowup({ title, body, ... })` authors a **pending `create task` proposal**
  (`createProposal`, `proposals.ts`) whose change-set is a single
  `{ op:"create", kind:"task", parentId:<milestone>, fields:{ title, kind, description } }`
  (`followups.ts:102`, `proposals.ts:47`). A `create` change's `fields` is an open
  record validated at *apply* time against the same insert the CRUD route uses, so it
  freely carries `repoId`, `description`, `kind` — everything an issue needs.
- The proposal lands in the **existing decision queue** (`GET /proposals/pending`), is
  reviewed as markdown, and on approve→apply the task joins the plan. From there the
  **existing task machinery dispatches it**: `POST /tasks/:id/dispatch` resolves the
  task's `repoId` to a cache clone and runs `claude --remote` there (`dispatch.ts:246`).
  A task whose `repoId` is set dispatches into the right repo automatically — no new
  dispatch plumbing.

So the entire *triage → approve → dispatch* back half is **already built**. Issue-triage
only has to add the *front* half: read issues, and author the `create task` proposal from
one. Concretely, a thin `proposeIssueTriage(issue)` sits beside `proposeFollowup`,
sharing `createProposal`.

### What differs from a follow-up (the real work)

Three things distinguish an issue from a worker follow-up, and each is a small, contained
addition — not a rewrite:

1. **Repo binding (the main new wiring).** A follow-up *inherits* its milestone (and thus
   repo) from the source task the worker was on (`followups.ts:37`). An issue instead
   **carries its own repo** — it lives in `owner/name`. So `proposeIssueTriage` must
   resolve that repo in the **repos registry** (find-or-create by slug, the same
   `gh`-sourced flow the repo picker uses — `vocabulary.md` § Repo) and set `repoId` on
   the proposed task's `fields`. That's what makes "dispatch a worker at this issue" run
   in the issue's repo. This is the one genuinely new piece.

2. **Which milestone does the task hang under?** A proposal needs a parent milestone;
   `proposeFollowup` falls back to *the first live milestone* (`followups.ts:42`). That's
   too arbitrary for issues arriving from a specific repo. Options, cheapest first:
   - **(a) Operator picks at approval.** Author the proposal against a best-guess
     milestone (first live, or one whose goal/milestone default-repo matches the issue's
     repo — `schema.ts` `repoId` cascade), and let the operator re-parent it in the plan
     after approve. Zero new schema. ← recommended for the first slice.
   - **(b) A per-repo "Triage / Inbox" milestone**, auto-created on first triage. Cleaner
     home, but adds a convention and a bit of lifecycle.
   - **(c) Pick in the triage UI** before authoring the proposal (a milestone select on
     the Issues pane row). More UI, deferred.

3. **Dedup / "already triaged" ledger.** Follow-ups dedup on the GitHub **comment**
   databaseId (`sourceCommentId`, `followups.ts:141`) so a comment becomes a proposal
   exactly once. Issues need the analogous guard keyed on **issue identity** — the issue
   `number` (per repo) or its GraphQL node id — so re-polling the same open issue every
   tick, or replaying it on a restart catch-up, never re-proposes it, and an issue the
   operator already *rejected* stays gone. Mechanically this mirrors the follow-up dedup:
   a provenance stamp on the proposal (`sourceIssueNumber` + `sourceRepoId`, parallel to
   the existing `sourceCommentId`/`sourcePr`/`sourceTaskId` columns on `proposals`), and
   a "this issue has a live/decided proposal" check before authoring. (Task **kind** also
   differs cosmetically: a follow-up is always a phase-less `bug`; an issue can map its
   labels → `TaskKind.Bug` when it's labelled a bug, else `TaskKind.Task`. Discovery-first
   either way — few or no phases, per `vocabulary.md` § Kind.)

### Read-only vs two-way (comment / close from PM)

**Recommendation: ship read-only, and don't build close-from-PM at all — GitHub already
does it for us.**

- **Read-only (v1): pull → view → triage → dispatch.** No writes to GitHub. The operator
  sees open issues, turns one into a proposed task, approves it, and dispatches a worker —
  all inside PowderMonkey. This is the whole loop the brief asks for and it needs zero
  write scope.
- **Why not close-from-PM.** The tempting "two-way" write is *close the issue when we're
  done*. But the dispatched worker opens a PR, and if that PR says `Closes #N`, **GitHub
  auto-closes the issue on merge** — which reconciliation already treats as the lifecycle
  clock (`github-watch.ts:26`). So PM owning the close would duplicate a thing GitHub does
  correctly, and risks closing an issue *before* the work actually lands. Have the triage
  step drop the issue number into the proposed task's description (so the worker writes
  `Closes #N` in its PR) and the close takes care of itself.
- **The one write worth considering later** is a *backlink comment* on the issue —
  "triaged into PowderMonkey (task t123), dispatched" — so the GitHub side isn't a black
  hole for anyone else watching the repo. The write seam already exists: `gh.ts`'s
  `commentOnPr` is one generalization away from `gh issue comment` (issues and PRs share
  the comment endpoint), exactly as `askClaude` reuses it today (`gh.ts:82`). Cheap, but
  **out of scope for v1** — it's a nicety, not part of the triage loop, and it's the
  natural second slice if two-way ever earns its keep.

Net: **read-only is the right cut.** It delivers the entire triage-and-dispatch loop, the
close is handled by GitHub's existing PR→issue link, and the only two-way write with real
value (a backlink comment) is a small, additive follow-on that reuses the `gh` seam.

## Recommendation

**Add read-only GitHub issue triage as a second instance of the existing PR-watch
pattern, feeding the existing proposal + dispatch machinery through one new "triage"
seam.** Concretely: a `github_issues` cache table filled by a GraphQL poll, live-synced to
an **Issues** dock pane, with a per-row "Triage" action that authors a `create task`
proposal from the issue. Everything downstream of the proposal — review, approve, dispatch,
reconcile-on-merge — is untouched. This maximises reuse (the watcher shape, the bus, the
`gh` seam, the live-sync collections, the proposal queue, the dispatcher all already
exist) and keeps the net-new surface to: one GraphQL query, one table + store, one
collection registration, one pane, and one `proposeIssueTriage` function.

## Rough design

### Data model

A new `github_issues` table, modelled column-for-column on `pull_requests` (`schema.ts:214`)
— a **cache** of polled GitHub state plus a tiny **triage ledger**, the same cache/ledger
split whose two write paths stay separate:

```
github_issues
  repo_id     integer   → repos.id   (which repo it came from; part of the key)
  number      integer                (issue number, unique per repo)
  title       text
  url         text
  state       text      OPEN | CLOSED
  author      text      login
  body        text      (for the triage view + task description)
  labels      jsonb     [{ name, color }]        — like proposals.changes, a JSON column
  gh_created_at text                             (issue createdAt)
  gh_updated_at text                             (issue updatedAt — the diff/sort key)
  comment_count integer
  -- triage ledger (survives restarts; the poll upsert never touches these) --
  triaged_proposal_id integer  → the proposal a triage authored (null until triaged)
  dismissed_at        timestamp (operator hid it from the inbox without triaging)
  ...timestamps
```

Primary key is the composite `(repo_id, number)` — an issue's identity is repo-scoped
(so is a PR's, but the current PR table keys on `number` alone because it watches one
repo; issues should be multi-repo-ready from the start per `vocabulary.md`). Register it as
a live-synced collection in `collections.ts` (`syncedCollection<GithubIssue>("github_issues", …)`)
so the pane reads it reactively with no fetch route.

**Proposal provenance.** The `proposals` table already carries `sourceTaskId` / `sourcePr`
/ `sourceCommentId` for follow-up provenance (`schema.ts:297`). Add the issue analogues —
`sourceIssueNumber` + `sourceRepoId` (nullable, null on a normal plan-edit proposal) — so a
triage proposal traces back to its issue and the dedup check has a key. The proposed task's
`fields` carry `repoId` (from the issue's repo), `title`, `description` (issue body + a
`Closes #N` hint), and `kind` (labels → `bug`/`task`).

### Sync cadence

Reuse the `github-watch` loop rather than a second timer where possible. Issues move slower
than active PRs, so they don't need the 10s PR cadence:

- **Simplest:** fold an issues fetch into the same tick but run it every *N*th tick (e.g.
  every 6th → ~60s), or gate it behind its own interval
  `PM_GITHUB_ISSUES_INTERVAL_MS` (default ~60_000; `0` disables, like the PR watcher).
- **Cost** is ~1 GraphQL point per repo per issues-poll — negligible against the 5000/hr
  budget even across several registered repos.
- The multi-repo story is identical to PRs: `vocabulary.md` already anticipates "PR
  watching polls each registered repo instead of one cached global slug" — issues ride the
  same loop over the repos registry.

### Dedup

Two dedup layers, both mirroring existing code:

1. **Poll dedup (don't re-emit on churn).** A `sig(issue)` over the fields we react to
   (`state | title | labels | gh_updated_at`) and a pure `diffGithubIssues(prev, next)`,
   copied from `sig` / `diffCloudPrs` (`github-watch.ts:320`, `:334`). Upsert changed rows;
   leave the rest.
2. **Triage dedup (don't re-propose).** Before authoring, check whether the issue already
   has a live/decided triage proposal — via `triaged_proposal_id` on the issue row, or a
   lookup on `proposals.sourceIssueNumber + sourceRepoId` (archived rows included, so a
   *rejected* triage stays gone). This is the direct analogue of the follow-up ingest's
   idempotency on `sourceCommentId` (`followups.ts:141`). Triage is **operator-initiated**
   in v1 (a button), not auto-ingested, so this guard mostly prevents a double-click and a
   re-triage of an already-handled issue — but it's the same mechanism, ready if auto-ingest
   is ever wanted.

### UI surface

- **Primary: an `Issues` list pane** (the triage inbox), registered like any dock pane —
  `dockComponents` + `PANE_TITLES` in `layout.ts`, an `IssuesPanel.tsx` wrapper, a
  `PaneButton` in `TopBar.tsx`, and the pane under `src/web/panes/issues/`. It reads the
  `githubIssues` collection via `useLiveQuery` and renders one row per open issue: the
  repo's colour swatch + icon (repos already have both — `vocabulary.md` § Repo), title
  (link to GitHub), labels (coloured chips from the `labels` jsonb), author, and a relative
  `updatedAt` (`src/web/time.ts`). Filters mirror the existing `FilterBar` (by repo, by
  label, by author). Each row's action is **"Triage"** → `POST /issues/:repo/:number/triage`
  → `proposeIssueTriage` → a toast ("proposed as a task — review in Proposals"), and a
  **"Dismiss"** to hide an issue from the inbox (`dismissed_at`).
- **The approve step needs no new UI** — the authored proposal shows up in the existing
  Proposals decision queue (the `ProposedStrip` / proposal review flow under
  `src/web/panes/tasks/`), and once applied the task is dispatchable from its normal card.
- **Optional later: an issue-detail takeover lens** for reading one issue's body +
  comments in depth, copying the `ReviewOverlay` pattern (`store.openReview` → a
  `position:fixed` overlay). Not needed for triage; the list row + GitHub link cover v1.

## First slice

The smallest end-to-end vertical that proves the loop — **poll an issue, see it in a pane,
turn it into a dispatched task** — reusing proposals and dispatch entirely:

1. **`fetchRepoIssues()`** in a new `src/server/issues.ts` (or folded into `github-watch`):
   the GraphQL query from the Survey, returning a typed `GithubIssue[]`; `null` on failure,
   like `fetchCloudPrs`.
2. **`github_issues` table + `issue-store.ts`** (`upsertIssueState`, `listIssues`), and a
   poll that `diff`s and upserts on the watch loop's slower cadence.
3. **`githubIssuesCollection`** — one line in `collections.ts` — so the browser gets it live.
4. **The `Issues` pane** — list rows (title, labels, author, updatedAt, repo swatch) + a
   **Triage** button. Register it in `layout.ts` / `TopBar.tsx`.
5. **`proposeIssueTriage(issue)`** beside `proposeFollowup` — resolve the issue's repo in
   the registry, author a `create task` proposal with `repoId` set and `Closes #N` in the
   description, stamp `sourceIssueNumber` / `sourceRepoId`, dedup on it. Route:
   `POST /issues/:repoId/:number/triage`.

**Deferred (explicitly out of the first slice):** the per-repo Triage/Inbox milestone (use
the best-guess parent + operator re-parent), the issue-detail overlay, any two-way write
(backlink comment / close), auto-ingest of issues into proposals, and pagination past 100
open issues.

**What the first slice deliberately reuses unchanged:** `createProposal` + the whole
proposal decision/apply flow, `POST /tasks/:id/dispatch` and the repo-cache clone,
reconciliation's PR→issue close on merge, the `/sync` collection engine, the `gh` seam, and
the `github-watch` loop/bus. The net-new code is one query, one table + store, one
collection line, one pane, and one `proposeIssueTriage` — the rest is wiring.
