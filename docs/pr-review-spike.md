# Spike: in-app PR review (Pierre evaluation + approach)

> Phase 301 of "Review PRs in-app". Goal: decide how PowderMonkey should host an
> embedded PR-review experience — render a PR diff, read/post inline review
> comments, and (later) a side-by-side editor pane — instead of bouncing the
> operator out to github.com. The brief named **Pierre (pierre.co)** as a thing to
> evaluate, so this starts there and ends with what we actually built.

## TL;DR

- **Pierre the git platform is dead** (the team labels it "Pierre.co, RIP
  2023–2026"). But the parts we'd want **survived as Apache-2.0 open source**:
  [`@pierre/diffs`](https://www.npmjs.com/package/@pierre/diffs) — a
  virtualization-first React diff renderer with an annotation framework for inline
  comments — and [`@pierre/trees`](https://www.npmjs.com/package/@pierre/trees), a
  virtualized file-tree component. So Pierre is **more than design inspiration**:
  there's reusable code, with caveats.
- For the **diff renderer** we deliberately **did not** pull in `@pierre/diffs` (or
  any diff library). The diffs we review are our own small `pm/task-*` PRs, the app
  is "useful over elegant / short shelf life" (see `design.md`), and the hand-rolled
  diff+comment renderer matches the rest of the app's panes. A Shiki-in-a-worker
  virtualized renderer is the right move only if/when we start reviewing large
  diffs; the seam is clean enough to swap later (see "If we outgrow this").
- For the **file tree** we *did* adopt `@pierre/trees` (operator's call) — a tree is
  enough of its own thing that hand-rolling buys little, virtualization helps a long
  file list, and it ships file-type icons + git-status colouring for free. It's the
  one third-party piece in the pane (~0.5 MB to the bundle, preact-based, themed via
  `--trees-*` CSS vars through its shadow root).
- What shipped (302/303 + follow-ups): a `Review` pane in the dockview split — a
  left sidebar (PR title + description + `@pierre/trees` file tree), a scrollable diff
  (parsed from `gh api .../pulls/{n}/files`) with threaded inline comments and a
  Unified/Split toggle, per-file **Viewed** collapse, and a footer that submits a
  **batched** review with an Approve / Request changes / Comment verdict (one webhook
  event, not one per comment). See `docs/pr-review.md`.

## What Pierre is, and its status

Pierre was a YC-W23 "all-in-one git platform for small teams" (Jacob Thornton /
Ian Ownbey) — git hosting + realtime code review + a multiplayer doc editor, with a
branch-page-instead-of-PR model and AI change summaries. The **hosted product shut
down**; `docs.pierre.co` no longer resolves. There is **no public record of an
acquisition** (no Stripe deal, despite rumors) — the consistent signal is
shutdown-and-pivot-to-OSS, not an acquihire. The team now ships the platform's
building blocks as standalone open source.

Sources: [pierre.computer](https://pierre.computer/) ·
[YC profile](https://www.ycombinator.com/companies/pierre) ·
["On Rendering Diffs"](https://pierre.computer/writing/on-rendering-diffs) ·
[github.com/pierrecomputer/pierre](https://github.com/pierrecomputer/pierre).

## What's actually reusable: `@pierre/diffs`

The headline finding. [`@pierre/diffs`](https://www.npmjs.com/package/@pierre/diffs)
(Apache-2.0, peer-deps `react ^18.3.1 || ^19`) is a maintained, framework-agnostic
diff/code renderer extracted from the platform:

- **React components** (`@pierre/diffs/react`): `MultiFileDiff`, `PatchDiff`,
  `FileDiff`, `File`, plus a `Virtualizer` scroll container. `PatchDiff` renders
  **unified patch strings directly** — i.e. the `patch` field GitHub returns from
  `GET /repos/{o}/{r}/pulls/{n}/files`, no hunk-parsing on our side.
- **Split and unified** layouts; Shiki syntax highlighting (run in **worker
  threads** with an LRU cache); light/dark theming; line selection; merge-conflict
  UI; "bring your own accept/reject UI".
- **A flexible annotation framework** (`DiffLineAnnotation` / `LineAnnotation`) —
  the hook you'd use to inject inline GitHub review comments.
- **Virtualization-first** ("render *any* diff"): mount/unmount files on scroll,
  binary-search line lookup, the "inverse sticky" trick for zero-blanking on fast
  scroll, and memory work that took a Linux v6→v7 kernel diff from 2.4 GB → 1.15 GB.

What it is **not**: it's a *renderer + annotation framework*, not a GitHub client
(you still own all API I/O — fetch files, read/post `pulls/{n}/comments`, map a
comment's `path`/`line`/`side` to an annotation) and not an *editor* (the future
side-by-side editable pane is a separate concern — Monaco / CodeMirror). It's also
not a Mantine component, so theming it to match is a styling task.

Caveat worth flagging: its docs are a client-rendered SPA that's hard to scrape, and
long-term maintenance rests on a post-shutdown team. Confirm the `PatchDiff` prop
shape against the package `.d.ts` before committing to it.

## Realistic alternatives for the diff + inline-comment pieces

| Option | Layouts | Inline comments | Big-diff perf | License | Notes |
|---|---|---|---|---|---|
| **`@pierre/diffs`** | both | yes (annotation API) | best (virtualized, worker Shiki) | Apache-2.0 | Newest/most novel; takes patch input directly; SPA-only docs. |
| **`react-diff-view`** | both | yes (`Decoration`/`widgets`, built for comments) | OK; no virtual scroll | MIT | The conventional, battle-tested choice; `parseDiff()` for unified diffs. |
| **`@git-diff-view/react`** | both | yes (drag-select lines, GitHub-style) | good | MIT | GitHub look-alike OOTB; modern. |
| **`diff2html`** | both | limited (HTML output) | OK | MIT | Good for read-only display, awkward for interactive comments. |
| **Monaco `DiffEditor`** | both (native) | custom (decorations/zones) | good per-file | MIT | Heavy (~5–10 MB); best fit for the *future editable* pane, not the PR list. |
| **CodeMirror 6 `@codemirror/merge`** | both | custom decorations | good | MIT | Light (~300 KB); one engine for view+edit+comments. |
| **Parse patches ourselves** | DIY | DIY | DIY | — | Max control, max work. ← what we did for v1. |

## Decision

**Diff renderer: parse the patches ourselves, no library. File tree:
`@pierre/trees`.** Rationale, weighed against `design.md`'s non-goals ("short shelf
life", "useful over elegant", single operator):

- The diffs in scope are our own `pm/task-*` PRs — small, text, a handful of files.
  Virtualization and worker-thread highlighting solve a problem the *diff* doesn't
  have. The parser is ~80 lines, pure, and unit-tested (`src/server/diff.ts`,
  `tests/diff.test.ts`); the renderer is plain Mantine/JSX that matches the app
  (themeAbyss dockview, dark panes) with nothing to keep in sync with a fast-moving
  upstream.
- A **file tree** is the exception: hand-rolling a nested, collapsible,
  icon-decorated tree buys little over `@pierre/trees`, which is Apache-2.0, ships
  file-type icons + git-status colouring, virtualizes a long list, and exposes a
  clean `useFileTree`/`<FileTree>` React API. It cost ~0.5 MB (preact-based) and a
  bit of shadow-DOM theming via `--trees-*` CSS vars — a fair trade for the
  navigation it gives. (This was the operator's call; the symmetry of using a Pierre
  package where it earns its keep, and skipping one where it doesn't, is the point.)
- The GitHub I/O for review goes through the same `gh` seam as `github-watch.ts`, so
  the architecture stays uniform.

**If we outgrow this** (we start reviewing large/external diffs, or want syntax
highlighting): the swap point is small. `src/server/pr-review.ts` already returns a
clean `{ files, comments, headSha }` payload; the file/hunk rendering in
`ReviewPane.tsx` is isolated in `FileView`. Replacing `FileView`'s hand-rolled hunk
loop with `@pierre/diffs`' `PatchDiff` + `DiffLineAnnotation` (feeding it the raw
`patch` and our comments) is a contained change — keep the server payload, swap the
renderer. `react-diff-view` is the MIT fallback if Pierre's maintenance stalls.

What we **borrow from Pierre as inspiration**, not code: the side-by-side/unified
toggle, threading comments inline under the anchored line, and "review lives in one
surface" rather than a separate tab per file.

## What shipped (302 / 303)

- `src/server/gh.ts` — the shared `gh` wrapper + repo resolution (extracted so
  `github-watch.ts` and the review routes share one seam).
- `src/server/diff.ts` — pure unified-`patch` → hunks parser (`parsePatch`).
- `src/server/pr-review.ts` — `getPrReview` (diff + comments, via `gh api`) and
  `postPrComment` (inline comment / threaded reply). Offline/demo seam:
  `PM_PR_FIXTURE_DIR` serves JSON dumps instead of calling `gh`.
- Routes: `GET /prs/:number/review`, `POST /prs/:number/comments` (`app.ts`).
- `src/web/ReviewPane.tsx` — the pane: file/hunk rendering, comment threads +
  composer, Unified/Split toggle. Opened as a dockview panel (`review`), reachable
  from a `Review` link on any task that has a PR (`plan-ui.tsx`, Active + Backlog).

See `docs/pr-review.md` for the runtime architecture and the side-by-side/dockview
notes (phase 303).
