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
- **We adopted both Pierre packages** (operator's call). `@pierre/diffs`' `PatchDiff`
  renders each file's diff (Shiki highlighting, split/unified, collapsed context,
  virtualization), with inline comment threads injected through its **annotation
  framework**; `@pierre/trees` renders the file tree (icons + git-status colours).
  The first cut hand-rolled the diff renderer (the rationale below still records *why*
  that was a reasonable default); we then swapped it for `@pierre/diffs` once the
  operator wanted richer rendering. The cost is bundle size — Shiki pulls the web
  bundle to ~13 MB — which is acceptable for a localhost single-operator tool.
- What we own around the Pierre components: all GitHub I/O via `gh` (fetch files,
  read/post `pulls/:n/comments`, submit reviews), the patch-header reconstruction
  (`fullPatch`), the comment draft/batch model, the dark theming, the viewed mechanic,
  and the dockview/overlay shell.
- What shipped: a full-window `Review` overlay hosting its own dockview — a
  Description panel (markdown PR title + body) and a Diff panel (`@pierre/trees` tree +
  `@pierre/diffs` diff), threaded inline comments + a per-line composer, per-file
  **Viewed** collapse, and a footer that submits a **batched** review with an
  Approve / Request changes / Comment verdict (one webhook event, not one per
  comment). See `docs/pr-review.md`.

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

**Use both Pierre packages: `@pierre/diffs` for the diff, `@pierre/trees` for the
file tree.** How we got here:

- **First cut — hand-rolled diff (then swapped).** The initial version parsed the
  patches ourselves (`parsePatch`) and rendered plain Mantine/JSX, on the reasoning
  that our `pm/task-*` PRs are small, text, a handful of files — so virtualization and
  worker-thread highlighting solve a problem the *diff* didn't have, and a ~80-line
  pure parser matched the app with nothing to track upstream. Reasonable as a default,
  and it kept the swap point small.
- **Then we adopted `@pierre/diffs`** (operator's call) for richer rendering: Shiki
  syntax highlighting, collapsed unchanged-context regions, and library-grade
  split/unified — things the hand-rolled renderer didn't do. Crucially, comments slot
  into its **annotation framework** (`lineAnnotations` + `renderAnnotation`), so our
  thread/draft/composer components render *inside* the diff. The swap was contained:
  the server payload already carried the raw `patch` per file, and the rendering was
  isolated. Cost: Shiki pulls the web bundle to ~13 MB — fine for a localhost
  single-operator tool; if that ever bites, `react-diff-view` (MIT, lighter, no Shiki)
  is the fallback.
- **`@pierre/trees`** for the file tree — Apache-2.0, file-type icons + git-status
  colouring, virtualized, clean `useFileTree`/`<FileTree>` API; hand-rolling a nested
  collapsible tree buys little.
- The GitHub I/O for review goes through the same `gh` seam as `github-watch.ts`, so
  the architecture stays uniform.

What we still **own** around the Pierre components: all `gh` I/O, the patch-header
reconstruction (`fullPatch`), the comment draft/batch-review model, dark theming, the
viewed mechanic, and the dockview/overlay shell. What we **borrow as inspiration**,
not code: the side-by-side/unified toggle and "review lives in one focused surface."

## What shipped

- `src/server/gh.ts` — the shared `gh` wrapper + repo resolution (extracted so
  `github-watch.ts` and the review routes share one seam) + stdin support for the
  batched-review POST.
- `src/server/pr-review.ts` — `getPrReview` (diff + comments, via `gh api`),
  `postPrComment` (inline comment / threaded reply), `submitReview` (batched review +
  verdict), and `fullPatch` (reconstruct a complete single-file patch for PatchDiff).
  Offline/demo seam: `PM_PR_FIXTURE_DIR` serves JSON dumps instead of calling `gh`.
- Routes: `GET /prs/:number/review`, `POST /prs/:number/comments`,
  `POST /prs/:number/review-submit` (`app.ts`).
- `src/web/ReviewPane.tsx` — the full-window review overlay: a dockview with a
  Description panel (markdown) and a Diff panel (`@pierre/trees` tree + `@pierre/diffs`
  `PatchDiff`), inline comments via the annotation framework, a per-line composer,
  per-file Viewed collapse, and the batched Approve / Request changes / Comment footer.
  Opened from a `Review` link on any task/PR (`plan-ui.tsx`, Active + Backlog).

See `docs/pr-review.md` for the runtime architecture and layout.
