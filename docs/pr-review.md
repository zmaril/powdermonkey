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
- **`src/server/pr-review.ts`** — `getPrReview` (three `gh api` calls in parallel)
  and `postPrComment` (inline comment, or a threaded reply when `inReplyTo` is set).
  GitHub's per-file `patch` is hunks-only; `fullPatch()` prepends a
  `diff --git`/`---`/`+++` header (with `/dev/null` for add/remove) so it's a
  complete single-file patch — what @pierre/diffs' `PatchDiff` expects.
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
├ Description (~1/3) ┬ Diff (~2/3) ────────────────────────────────────────┤
│ PR title           │ FILES  n/m viewed │  src/web/plan-ui.tsx [Viewed]    │
│ #n · state         │ ▾ src/web         │  @@ hunk … lines … threads …     │
│ description (md)   │   plan-ui.tsx  M  │  pending … composer              │
│                    │   store.ts     M  │  …                               │
├ footer: Finish review (summary + Approve / Request changes / Comment) ────┤
```

The default layout (`buildReviewLayout`) puts **Description** on the left (~1/3) and
**Diff** — the tree + diff as one panel — on the right (~2/3). It's rebuilt fresh
each open (the modal layout isn't persisted). Esc (when not typing) or **✕ Close**
drops back to the workspace.

The two dockview panels share one PR's state (diff data, view mode, draft, viewed,
compose). Rather than thread that through panel params, it's held in `ReviewPane` and
passed via a React **context** (`ReviewCtx`) wrapping `<DockviewReact>` —
dockview-react renders panels through React portals, which preserve context from
above, so each panel reads its slice live.

- **Description panel.** PR title, number/state, and the description — both the title
  and body are rendered as **markdown** (`marked` → sanitized with `DOMPurify`, since
  a PR description can come from a contributor; styled dark via an injected `.pm-md`
  stylesheet).
- **Diff panel — file tree + diff.** A file tree rendered with
  **[`@pierre/trees`](https://www.npmjs.com/package/@pierre/trees)**
  (`useFileTree` + `<FileTree>`) — virtualized, file-type icons, git-status colours
  (we map GitHub's per-file `status` → its `gitStatus`). It renders in a shadow root,
  themed by the full `--trees-*-override` set on the host (they pierce the shadow
  boundary — a *partial* set leaves it rendering light). Selecting a file scrolls the
  diff to it (`onSelectionChange` → a registered ref's `scrollIntoView`).
- **Diff rendering — `@pierre/diffs`.** Each file is rendered by `PatchDiff`
  (`@pierre/diffs/react`) from the full patch: Shiki syntax highlighting, split or
  unified (`options.diffStyle`), collapsed unchanged-context regions, virtualization.
  It runs on the main thread (`disableWorkerPool`) and renders in a shadow root,
  themed with a dark Shiki theme (`github-dark`). We keep our own file header above it
  (name · status · +/- · **Viewed**).
- **Viewed / unviewed.** That **Viewed** checkbox (GitHub's mechanic) collapses the
  file's diff and bumps the sidebar's `n/m viewed` count. State is per-file, persisted
  to `localStorage` keyed by PR number + head sha, so it survives a reload (and resets
  when the PR gets new commits).

## Comments — @pierre/diffs annotations

Comment threads are injected into the diff via @pierre/diffs' **annotation framework**
rather than rendered by us between lines:

- **Anchoring.** A comment anchors to `RIGHT`/new-line (added or context lines) or
  `LEFT`/old-line (removed) — GitHub's model. We map that to the lib's
  `additions`/`deletions` side and pass one `DiffLineAnnotation` per anchored line
  (`{ side, lineNumber, metadata }`) in `lineAnnotations`; `renderAnnotation` returns
  the React node for that line — the posted **Thread** (+ `↳ reply`), any **pending**
  drafts, and the open **Composer**. `keyOf(path, {side, line})` ties them together.
- **Starting a comment.** Clicking a **line number** (or the gutter **+** on hover)
  fires the lib's `onLineNumberClick` / `onGutterUtilityClick`, which opens the
  composer for that line. New comments are **added to a draft** (see below), not
  posted one-by-one.
- **Replies** to an existing thread post immediately (the reviews API can't express a
  reply); everything else batches.

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

The header's **Unified / Split** toggle just sets `@pierre/diffs`' `options.diffStyle`
(`"unified"` | `"split"`) — the library handles the alignment (and intra-line
highlighting), and our annotations render the same way in either layout.

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
- Render against fixtures with no network: boot a scratch server per the
  [frontend-verify recipe](../CLAUDE.md#verify-frontend-changes-by-actually-rendering-them),
  adding `PM_PR_FIXTURE_DIR=/path/to/fixtures` and `PM_GITHUB_WATCH_INTERVAL_MS=0`, then
  `curl -s localhost:4500/prs/17/review | head -c 400` and drive headless Chromium — open
  Backlog → Review on a task whose `prUrl` points at the fixture PR.

> Note: the **write path** (posting a comment) shells out to `gh` and was exercised
> against fixtures (which reject writes) and by reading the constructed `gh api`
> argv; it has **not** been fired against live GitHub from this environment (`gh`
> isn't installed in the CI container). The read path is verified end-to-end with
> real PR data in the screenshots on the PR.
