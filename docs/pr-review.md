# In-app PR review

How the Review pane works, and how the side-by-side layout ties into the dockview
split. For the "should we use Pierre / a diff library" decision, see
[`pr-review-spike.md`](./pr-review-spike.md).

## Runtime shape

```
ReviewPane (src/web/ReviewPane.tsx)
   │  GET /prs/:n/review            POST /prs/:n/comments
   ▼                                       ▼
pr-review.ts ──────── gh.ts (`gh api …`) ──────── GitHub
   │  getPrReview()                postPrComment()
   │     ├─ pulls/:n            (files → diff.ts parsePatch → hunks)
   │     ├─ pulls/:n/files      (per-file unified `patch`)
   │     └─ pulls/:n/comments   (inline review comments)
   ▼
PrReview { number, title, state, headSha, url, files[], comments[] }
```

- **`src/server/gh.ts`** — the single seam to the GitHub CLI (spawn + repo
  resolution), shared with `github-watch.ts`. Never throws; a missing `gh`/auth
  comes back as `{ ok: false }`.
- **`src/server/diff.ts`** — `parsePatch(patch)` turns one file's unified `patch`
  (the `patch` field of `pulls/:n/files`) into `Hunk[]`, each line carrying both its
  old and new line numbers. Pure, dependency-free, unit-tested
  (`tests/diff.test.ts`).
- **`src/server/pr-review.ts`** — `getPrReview` (three `gh api` calls in parallel)
  and `postPrComment` (inline comment, or a threaded reply when `inReplyTo` is set).
  **Offline seam:** set `PM_PR_FIXTURE_DIR` to a directory of JSON dumps
  (`pr-<n>.json`, `pr-<n>-files.json`, `pr-<n>-comments.json`, in raw GitHub REST
  shape) and the read path serves those instead of calling `gh` — how the
  screenshots below were produced with no network. Writes are disabled in fixture
  mode.
- **Routes** (`app.ts`): `GET /prs/:number/review`, `POST /prs/:number/comments`.
  A GitHub failure is a 502 with `{ error }`; the pane shows it inline.

## Layout

Reviewing a PR is a focused, take-over activity, so it's a **full-window overlay**
(`ReviewOverlay` in `App.tsx`: `position: fixed; inset: 0` above everything, top bar
included) rather than another tab competing for the main split. Inside the overlay
is the review's **own dockview** with two panels, so the operator can drag / resize /
re-tab the review surface itself:

```
┌ header: REVIEW #n title · [Unified|Split] · Refresh · ✕ Close ───────────┐
├ Description (~1/3) ┬ Files (~2/3) ───────────────────────────────────────┤
│ PR title           │ FILES  n/m viewed │  src/web/plan-ui.tsx [Viewed]    │
│ #n · state         │ ▾ src/web         │  @@ hunk … lines … threads …     │
│ description (md)   │   plan-ui.tsx  M  │  pending … composer              │
│                    │   store.ts     M  │  …                               │
├ footer: Finish review (summary + Approve / Request changes / Comment) ────┤
```

The default layout (`buildReviewLayout`) puts **Description** on the left (~1/3) and
**Files** — the tree + diff as one panel — on the right (~2/3). It's rebuilt fresh
each open (the modal layout isn't persisted). Esc (when not typing) or **✕ Close**
drops back to the workspace.

The two dockview panels share one PR's state (diff data, view mode, draft, viewed,
compose). Rather than thread that through panel params, it's held in `ReviewPane` and
passed via a React **context** (`ReviewCtx`) wrapping `<DockviewReact>` —
dockview-react renders panels through React portals, which preserve context from
above, so each panel reads its slice live.

- **Description panel.** PR title, number/state, and the markdown description body.
- **Files panel — file tree + diff.** A file tree rendered with
  **[`@pierre/trees`](https://www.npmjs.com/package/@pierre/trees)**
  (`useFileTree` + `<FileTree>`) — virtualized, file-type icons, git-status colours
  (we map GitHub's per-file `status` → its `gitStatus`). It renders in a shadow root,
  themed by the full `--trees-*-override` set on the host (they pierce the shadow
  boundary — a *partial* set leaves it rendering light). Selecting a file scrolls the
  diff to it (`onSelectionChange` → a registered ref's `scrollIntoView`). This is the
  one place we took a Pierre package — the diff renderer is still hand-rolled (see
  the spike); a tree is enough of its own thing, and virtualization helps a big PR.
- **Viewed / unviewed.** Each file header has a **Viewed** checkbox (GitHub's
  mechanic): ticking it collapses the file and bumps the sidebar's `n/m viewed`
  count. State is per-file, persisted to `localStorage` keyed by PR number + head
  sha, so it survives a reload (and resets when the PR gets new commits). You can
  still expand a viewed file manually with its ▾.

## The pane

`ReviewPane` renders the diff off the payload — no diff *library* (the file tree is
the one third-party piece), matching the rest of the app's hand-rolled Mantine panes.

- **Comment anchoring.** A diff line anchors a comment to `RIGHT`/new-line for added
  or context lines, `LEFT`/old-line for removed — the same model GitHub's
  `pulls/:n/comments` uses. `keyOf(path, {side, line})` keys both the rendered
  threads and the open composer, so a comment lands back under the exact line it was
  written on.
- **Threads.** Top-level comments render under their line; replies
  (`in_reply_to_id`) nest beneath their root, with a `↳ reply` composer.
- **Composer.** Hovering a line reveals a `+`; clicking it opens an inline textarea.
  New line comments are **added to a draft** (see below), not posted one-by-one.

## Batched review: approve / request changes / one event

New comments don't post immediately. Hitting **Add to review** appends them to a
**local draft** — each renders as an amber `pending` card under its line with a
`remove` link, and nothing has hit GitHub yet. The footer **Finish review** bar then
submits the whole pass at once: a summary plus a verdict — **Approve**, **Request
changes**, or **Comment** — via `POST /prs/:n/review-submit` →
`POST /repos/:o/:r/pulls/:n/reviews` with the full `comments[]` array and an
`event`.

Why: it answers "can I approve/deny in-app?" (the verdict) and "can I batch comments
to avoid churn?" (the draft) with the same mechanism. A standalone comment per line
is one webhook *per comment* — which wakes a watching session each time; one review
is **one event** for the whole pass. `gh` can't express a nested `comments[]` via
`-f` flags, so the JSON body is fed on stdin (`gh api … --input -`, see `gh.ts`).

Validation mirrors GitHub: Request changes needs a summary; a Comment review needs
either a summary or at least one inline comment; Approve may be empty.

The one thing still posted immediately is a **reply** to an existing thread — the
reviews API has no way to express a reply, so it goes through
`POST /prs/:n/comments` with `inReplyTo`. Replies mid-review are rare, so this is a
deliberate small exception to the batch model.

## Side-by-side (split) layout

The pane has a **Unified / Split** toggle. Unified interleaves +/- in one column;
split renders old-on-left, new-on-right.

The pairing is `toSplitRows(hunk)`:

- a **context** line aligns on both sides (same text left and right);
- a run of **removals** is zipped row-by-row against the **additions** that follow
  it, so a typical edit lines up old-vs-new; leftover removals (left-only) or
  additions (right-only) get an empty cell on the other side.

Comment anchoring is unchanged — each non-empty cell resolves the same
`anchorOf(line)`, so threads and the composer work identically in either layout, and
a thread renders full-width beneath the row it belongs to.

This is a pragmatic alignment, not a Myers-grade side-by-side: it doesn't do
intra-line word diffing or move detection. That's deliberate (see the spike's
"useful over elegant" rationale); if we want better, that's the point where
`@pierre/diffs` or `react-diff-view` earns its keep.

## Opening / closing it

The Review pane lives outside the dockview split — it's the one full-window surface,
so it never competes with the shell / plan tabs for space:

- A **Review** link (`plan-ui.tsx` `ReviewLink`, parsing the PR number out of
  `task.prUrl`) appears on any task that has a PR, in both the Active and Backlog
  panes. Clicking it calls `store.openReview(number, title)`, which sets
  `store.review`.
- `ReviewOverlay` (`App.tsx`) renders whenever `store.review` is set: a fixed,
  full-window layer over the whole app hosting `<ReviewPane onClose={closeReview}>`.
  Esc (ignored while a textarea/input is focused, so it can't eat a comment draft) or
  the header's **✕ Close** calls `store.closeReview()`.
- It is **not** persisted in the dockview layout — closing it returns to exactly the
  workspace you left.

Earlier this was a dockview panel; it was moved to a takeover overlay because review
is a focused activity, not a tab you leave parked in the split.

## Future: an editable side-by-side editor pane

The brief's stretch goal is a code-editor pane (not just a viewer). That's a
separate concern from this diff viewer — it wants a real editor engine. The natural
fit, given dockview already hosts xterm panes, is a **CodeMirror 6 +
`@codemirror/merge`** panel (light, one engine for view + edit + custom
comment decorations) or **Monaco `DiffEditor`** (heavier, VS-Code-grade). It would
register as another `dockComponents` entry and open the same way `review` does. The
server payload here (`headSha`, per-file content) is most of what such a pane needs
to read/write a worktree file; wiring the write path back through the existing
worktree session is the open question.

## Verifying

- `bun test tests/diff.test.ts` — the parser.
- Render with fixtures, no network:
  ```sh
  bun run build:web
  PM_PR_FIXTURE_DIR=/path/to/fixtures PORT=4500 \
    PM_DATA_DIR="$(mktemp -d)/pg" PM_TMUX_SOCKET=pm-demo \
    PM_SUPERVISOR_CMD=true PM_RECONCILE_INTERVAL_MS=0 PM_GITHUB_WATCH_INTERVAL_MS=0 \
    bun run src/server/index.ts &
  curl -s localhost:4500/prs/17/review | head -c 400
  ```
  then drive headless Chromium (see `CLAUDE.md`) — open Backlog → Review on a task
  whose `prUrl` points at the fixture PR.

> Note: the **write path** (posting a comment) shells out to `gh` and was exercised
> against fixtures (which reject writes) and by reading the constructed `gh api`
> argv; it has **not** been fired against live GitHub from this environment (`gh`
> isn't installed in the CI container). The read path is verified end-to-end with
> real PR data in the screenshots on the PR.
