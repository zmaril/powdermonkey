# Spike: import / view GitHub issues to triage + dispatch

> Goal: decide how PowderMonkey should pull a repo's **open GitHub issues** into a
> viewing surface where the operator can triage them and **dispatch a worker** at one —
> turning "there's an issue" into "there's a task, and it's running." The brief asked to
> survey how the existing PR watcher works, sketch the issue → task path (reusing the
> follow-up / proposal machinery), decide read-only vs two-way, and pick a first slice.

This doc is built up across the spike's three phases: **Survey** (below), **Issue → task**,
then the **Recommendation + rough design + first slice**.

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
