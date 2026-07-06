# Spike: new linters / static analysis to adopt

> Goal: figure out whether any off-the-shelf linter or static-analysis tool is
> worth adopting on top of what we already run — specifically one that would have
> caught the real bugs that slipped past our current gates (type errors that only
> `tsc` sees, desktop-unsupported web APIs like `window.open`, unhandled
> `fetch`). This records the inventory, what each candidate actually adds when run
> on *this* repo, and a shortlist with the specific rules that map to our bugs.

## TL;DR

- **Adopt now:** nothing that replaces a gate — but two small additions earn their
  keep. **A local/pre-push `tsc` gate** (the single highest-value change; the
  tooling already exists, it just isn't run before CI) and a **~4-rule `ast-grep`
  config** to cover the three hand-rolled-lint-shaped gaps we don't yet guard
  (`window.open` outside `openExternal`, `fetch` without an `.ok`/try-catch
  handler, and — folding in the existing scripts later — dock-theme + spacing).
- **Try (behind a flag, non-gating first):** **knip** (finds dead exports/files/deps
  — real signal on this repo, see below) and **oxlint** (a fast typed-lint-ish pass
  that catches floating promises / no-explicit-any beyond biome's recommended set).
- **Skip / not yet:** **semgrep** (heavier than ast-grep for the same custom-rule
  job here, slower CI, OSS ruleset is mostly server-security noise for a
  localhost tool), **dependency-cruiser** (overlaps knip + biome; the import graph
  here is small), **type-coverage** (strict is already on; low marginal signal),
  **publint/attw** (we publish, so a *periodic* check is worth it, but the package
  is Bun-run source not a compiled dual-format lib, so the payoff is small).

---

## Phase 1 — what we already enforce, and where bugs still slip through

### The gates today

Everything below runs in CI (`.github/workflows/ci.yml` `check` job, plus the
separate `straitjacket` job) and most of it via `bun run check` locally.

| Gate | What it is | Scope | Catches |
|---|---|---|---|
| **biome** (`biome.json`, v2.5.2) | `bun run check` → `biome check --error-on-warnings src`. `recommended` rules only + formatter (2-space, width 100) + import organizing. One override for `motion.css`. | `src/` | unused vars/imports, a11y basics, a slice of correctness (`noExplicitAny` etc.). **No type info.** |
| **lint-strings.ts** | Hand-rolled char-scanner. Reads the closed vocabularies out of `src/shared/types.ts` and flags any bare string literal elsewhere that equals an enum value. Escape: `// lint-allow-string`. | `src/**/*.{ts,tsx}` | stringly-typed regressions (`"stopped"` instead of `SessionState.Stopped`). See `docs/typed-strings.md`. |
| **lint-dock-theme.ts** | Hand-rolled scanner. Flags any `theme*` import from `dockview-react` outside `themes.ts`. Escape: `// lint-allow-dock-theme`. | `src/web/` | a component hardwiring a dock theme and bypassing the theme picker (a real bug the review pane had). |
| **lint-spacing.ts** | Hand-rolled scanner. Flags raw-px Mantine spacing props (`gap={6}`) that ignore the density scale; `{0}` allowed. Escape: `// lint-allow-spacing`. | `src/web/` | spacing that won't scale with the density control. |
| **straitjacket** (`zmaril/straitjacket@v0.2.3`) | Separate CI job. Scans for the weird duplicated/boilerplate code LLMs tend to emit; fails on any finding (count is currently 0, held there). SARIF upload to code scanning. | `src/` | LLM-slop duplication. |
| **tsc** (`tsc --noEmit`, `strict`) | `bun run typecheck`. In CI's `check` job. `include: src, tests, drizzle.config.ts`. | whole TS project | every type error. Added in **PR #90** after CI had been *linting but never typechecking*. |
| adjacent (synced-from-fleet) | **vale** (prose), **codespell** (spelling), **stylelint** (CSS), **housekeeping** action (dead links, stale PRs). | repo | prose/CSS/repo hygiene — not TS static analysis, out of scope here. |

Two structural notes that matter for the survey:

- **No custom-rule engine.** All three project-specific rules are hand-rolled
  char-by-char scanners (deterministic, dependency-free, unit-tested in `tests/`).
  The `lint-strings.ts` header explains why: biome has no custom-rule support, and
  an `eslint` + type-aware-parser stack "for a single rule is more machinery than
  the check is worth." That reasoning is the crux of the survey — a lightweight
  structural-rule engine (ast-grep) changes that calculus.
- **`bun run` never typechecks.** Bun executes TS by *stripping* types (esbuild
  transpile). So `bun test`, `bun run dev`, and the compiled build all pass on
  type-broken code. `tsc` is the only thing that sees types, and it lives only in
  CI.

### Where bugs still slip through

The three named bug classes, each a real incident in the history:

**1. `tsc`-not-run-locally.** Because `bun run` strips types, an agent (or human)
gets *green `bun test`* on code that doesn't typecheck — false confidence, and the
break only surfaces on CI minutes later (or, before PR #90, never).

- **PR #90** (`5e10a2e`): "82 type errors were invisible because CI linted but
  never typechecked." Wiring `tsc --noEmit` into CI surfaced them all at once.
- **`6344a32`**: a `TS2339` — `table.position` accessed across the four-table
  union where `goals` has no `position` column. Passed lint and tests; only `tsc`
  caught it. Fixed by narrowing the union.
- **Gap:** `tsc` is in CI but **nothing runs it before the push** — no pre-commit /
  pre-push hook, and it's not in the fast inner loop. A tool that made typecheck
  *fast and local* (or a hook that just runs the existing `tsc`) closes this.

**2. Desktop-unsupported web APIs.** The UI runs in both a browser and the Tauri
webview, and some web APIs differ or are absent in the desktop shell.

- **`3152cb0` / `586a591`**: `window.open(uri, "_blank")` opens the page *inside*
  the app's own webview on desktop (there's no browser tab to hand it to). Fixed by
  routing every external link through `openExternal()` (`src/web/open-external.ts`),
  which calls the Tauri opener plugin on desktop and falls back to `window.open` in
  a browser.
- **Gap:** nothing stops a *new* `window.open` / `target=_blank` handler from
  regressing this. It is exactly the shape `lint-dock-theme.ts` already guards — a
  banned call outside one approved wrapper — but there's no equivalent guard for
  `window.open`. Other desktop-fragile APIs (`localStorage`, `navigator.clipboard`,
  `alert/confirm`) are in the same family.

**3. Unhandled `fetch`.** The house convention is that every `fetch` handles
failure — check `res.ok`, wrap in `try/catch`. `useConnectionWatch.ts` and the
`ShellTerminal` upload both do this. But nothing *enforces* it:

- A new `await fetch(...)` in an event handler with no `try/catch` is an unhandled
  promise rejection; `await res.json()` without a preceding `res.ok` check silently
  parses an error body as if it were data.
- **Gap:** no rule flags a bare/unhandled `fetch`. There are only 7 `fetch` sites
  today, so a structural rule here is cheap and the convention is crisp enough to
  encode.

**General gaps beyond the three:** biome `recommended` is a small set — no
dead-code / unused-export detection, no import-cycle rules, and (critically) **no
type-aware lint**: floating promises, `no-misused-promises`, `no-floating-promises`
are exactly the family that would have flagged an unhandled `fetch` promise, and
biome can't see them. We also **publish the package** (`prepublishOnly`, `files`,
`bin` in `package.json`) with no publish-time validation.

*(Phases 2 and 3 below record the candidate trials and the recommendation.)*
