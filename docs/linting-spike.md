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
- **Optional:** **publint** at prepublish (caught a missing `license` field; guards
  future `bin`/`files` mistakes since we do publish).
- **Skip:** **semgrep** (heavier than ast-grep for the same custom-rule job here,
  slower CI, OSS ruleset is mostly server-security noise for a localhost tool),
  **dependency-cruiser** (overlaps knip + biome; the import graph here is small),
  **type-coverage** (strict is already on; low marginal signal), **attw** (we ship a
  CLI, not a types-exporting library — nothing for it to resolve).

- **The one operator call:** unhandled `fetch` is the only bug class no *lightweight*
  tool cleanly closes — true floating-promise detection is type-aware
  (typescript-eslint), which is the heavy eslint stack the repo has deliberately
  avoided. Recommendation is an ast-grep syntactic proxy first; details in Phase 3,
  flagged on the PR thread.

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

---

## Phase 2 — candidate trials (run on this repo)

Every tool below was run against the actual tree (via `bunx`, in a scratch dir —
nothing committed). Timings are wall-clock on the 19k-LOC `src/` + `tests/`.

### oxlint — fast, but type-blind

`oxlint@0.44` (Rust). **~0.6s** on the whole tree.

- **Default (`correctness` only):** 2 low-value warnings (`no-new-array`,
  `no-control-regex`). Quiet.
- **All plugins + `pedantic`:** floods. `react-in-jsx-scope` fires ~40× — a *false*
  alarm under React 19's automatic JSX runtime (we don't import React); plus pure
  style noise (`max-lines-per-function`, `no-inline-comments`, `max-dependencies`).
  So the usable surface is `correctness` + a hand-picked slice of `suspicious`, not
  the broad categories.
- **Overlap:** heavy with biome `recommended` — both catch the correctness basics.
  oxlint is faster and has a few rules biome lacks, but biome is already our
  formatter+linter, so *replacing* it isn't worth it.
- **The decisive limitation:** oxlint is **type-agnostic by design** (it skips the
  type-aware rules for speed). So it does **not** have `no-floating-promises` /
  `no-misused-promises` — i.e. **it would not catch the unhandled-`fetch` bug
  class.** That's the rule we most wanted from it, and it isn't there.

### knip — real signal after config (phantom deps + dead files)

`knip@5`. **~1–3.6s**.

- **Zero-config: mostly false positives** — it flags all 47 `tests/*.test.ts` +
  `scripts/*.ts` as "unused files" because it doesn't know they're entry points.
- **With a small config** (entry = `bin` + `src/server/index.ts` + `src/web/main.tsx`
  + `tests/**/*.test.ts` + `scripts/*.ts`), the noise collapses and what's left is
  **genuine**:
  - **Unlisted (phantom) dependencies** — `@dnd-kit/utilities` is imported in two
    web files but is *not* in `package.json` (only `@dnd-kit/core` + `/sortable`
    are); it resolves only transitively today. `dockview-core/dist/styles/*.css` is
    imported directly but only `dockview-react` is declared. **Both are real latent
    bugs** — a transitive-dep bump could break the build. *Verified by hand.*
  - **Dead file** — `src/web/plan-md-diff.ts` is imported nowhere in `src`/`tests`/
    `scripts`. *Verified: genuinely unreferenced.*
  - **Unused exports (56):** the noisy category — inflated by the `plan-ui/index.ts`
    barrel (re-exports counted as unused) and test-only exports. Needs scoping
    (`--include files,dependencies`) or curation before it's trustworthy.
- **Verdict:** real value in the `files` + `dependencies` scope; run it there,
  non-gating first.

### ast-grep — the best fit for our custom-rule gaps

`ast-grep@0.44`. **Instant.** This is the tool that maps directly onto our
hand-rolled scanners.

- A 6-line YAML rule (`pattern: window.open($$$)`, `language: typescript`) run via
  `ast-grep scan` cleanly flags **all three** `window.open` sites — the two in the
  `openExternal` wrapper and the one in `window-bridge.ts`. Excluding the wrapper is
  a one-line `ignores` glob or an inline `// ast-grep-ignore` comment — the **same
  escape-hatch shape** as our existing `// lint-allow-*` comments.
- **`ts` and `tsx` are separate languages** in ast-grep — a rule needs to target
  each (two short rules, or list both), a minor gotcha worth knowing.
- **It can absorb two of the three hand-rolled scripts.** `lint-dock-theme.ts` (a
  banned import) and `lint-spacing.ts` (a banned prop-value shape) are both fixed
  patterns — a few lines of YAML each. It **cannot** replace `lint-strings.ts`: that
  one *reads the vocabulary dynamically out of `types.ts`* and cross-references, so
  it's data-driven, not a fixed pattern — hardcoding the enum values into a rule
  would defeat the single-source-of-truth. Keep `lint-strings.ts` as-is.
- **On unhandled `fetch`:** ast-grep can enforce *syntactic* shapes (e.g. a banned
  `fetch(...).then()` without `.catch()`), but the true "floating promise" is a
  *type-aware* property — ast-grep can't see that a bare `await fetch()` in a
  handler with no `try/catch` is unguarded across control flow. Partial coverage
  only.

### type-coverage — low marginal signal, `strict` already on

`type-coverage@2 --strict`. **~15.5s** (slow). Reports **98.80%**; nearly every
untyped spot is an `as` cast in a **test fixture** (`{ ... } as Session`). With
`strict: true` already in `tsconfig`, the marginal signal is small and it's mostly
test scaffolding. **Skip.**

### publint / attw — we publish, but we ship a CLI, not a types library

- **publint@0.3:** one real suggestion — *"does not specify the `license` field but
  a LICENSE file was detected."* A one-line fix, and publint would also catch future
  `files`/`bin` publish mistakes. Minor but real; worth a periodic/prepublish run.
- **attw (`@arethetypeswrong/cli`):** reports `Resolution failed` on every target —
  **expected and not a bug.** attw checks a library's *type exports* across module
  resolutions; powdermonkey ships a **CLI** (`bin`, no `main`/`exports`/`types`), so
  there's nothing for it to resolve. **Wrong tool for us — skip.**

### dependency-cruiser / semgrep — not a fit here

- **dependency-cruiser:** `--no-config` cruised **0 modules** — it needs a real
  config (tsconfig resolution, extensions) before it does anything. Its unique value
  (import cycles, layer-boundary rules) overlaps knip's orphan detection + biome, and
  the import graph in a 19k-LOC single-app repo is small. Setup cost > payoff today;
  revisit if the graph grows.
- **semgrep:** *not trialed hands-on* — it's a Python/binary install, heavier than
  everything above, and its sweet spot (cross-language taint/security patterns) is
  aimed at a different problem than our TS-convention rules. For the custom-rule need
  ast-grep covers the same ground with a fraction of the setup, and semgrep's OSS
  registry is mostly server-security rules that don't apply to a localhost,
  no-auth-by-design, single-operator tool. Skip for this repo.

### At a glance

| Tool | Speed | Signal on *this* repo | Noise | Overlap | Fit |
|---|---|---|---|---|---|
| **oxlint** | 0.6s | correctness basics; **no type-aware rules** | high past `correctness` | biome | Try (supplement, won't fix our bugs) |
| **knip** | 1–3.6s | phantom deps + dead file (real) | high w/o config | — | **Try** (scope to files+deps) |
| **ast-grep** | instant | banned-call rules (`window.open`, dock, spacing) | low | our lint scripts | **Adopt** (small ruleset) |
| **type-coverage** | 15.5s | 98.8%, mostly test casts | low | tsc strict | Skip |
| **publint** | ~2s | missing `license` field | low | — | Optional (prepublish) |
| **attw** | ~3s | N/A — we ship a CLI | — | — | Skip |
| **dependency-cruiser** | needs config | cycles/layers (none found) | — | knip/biome | Skip |
| **semgrep** | (not run) | security taint (wrong problem) | — | ast-grep | Skip |

---

## Phase 3 — recommendation

### The bug classes → what actually catches each

This is the crux: map the three real incidents to the rule that would have caught
them. The answer is **not "adopt one big linter"** — it's three different, small
moves, and one of them isn't a linter at all.

| Real bug | What catches it | Tool | New dep? |
|---|---|---|---|
| **`tsc`-not-run-locally** (PR #90's 82 errors; the `goals.position` TS2339) | Running the `tsc` we *already have*, **before the push** | a `pre-push` git hook / `bun run` step calling `bun run typecheck` | **none** |
| **desktop web API** (`window.open` bypassing `openExternal`) | banned-call rule | **ast-grep** `no-raw-window-open` | ast-grep |
| **unhandled `fetch`** (floating promise / missing `res.ok`) | type-aware `no-floating-promises` / `no-misused-promises` — **or** a syntactic proxy | typescript-eslint (heavy) *or* ast-grep (partial) | see note |

**Bug class 1 is the highest-value and needs no new tool.** It's the most frequent
failure mode (an agent gets green `bun test` on type-broken code because `bun run`
strips types) and the fix is purely process: run the existing `tsc` locally. A
`pre-push` hook is enough:

```sh
# .git/hooks/pre-push  (or wire into scripts/dev.sh / a bun script)
bun run typecheck || { echo "tsc failed — fix before pushing"; exit 1; }
```

**Bug class 2 is a clean ast-grep win.** The rule that would have prevented the
`window.open` regression, verified against the tree in Phase 2:

```yaml
# ast-grep rule — flags window.open outside the openExternal wrapper.
# (needs a twin with language: tsx for .tsx files)
id: no-raw-window-open
language: typescript
severity: error
message: Route external links through openExternal() so they open in the OS
  browser on desktop. Deliberate in-app windows add `// ast-grep-ignore`.
rule:
  pattern: window.open($$$)
ignores:
  - "src/web/open-external.ts"      # the wrapper itself
  - "src/web/window-bridge.ts"      # deliberate in-app window spawn
```

**Bug class 3 is the one genuine judgement call.** True floating-promise detection
is *type-aware*, and the only tools that do it well are typescript-eslint's
`no-floating-promises` / `no-misused-promises`. But standing up typescript-eslint is
exactly the *"eslint + type-aware-parser stack … more machinery than the check is
worth"* that `lint-strings.ts` explicitly rejected — and oxlint, the fast
alternative, deliberately omits type-aware rules. So the three honest options:

- **(a) ast-grep syntactic proxy** — flag `fetch(...)` not immediately `await`ed/
  `return`ed, or `.json()` reached without a preceding `res.ok`. Cheap, same engine
  as bug class 2, but *approximate* (misses some, may false-positive). 7 `fetch`
  sites total, so the blast radius is tiny either way.
- **(b) typescript-eslint, scoped to just the two promise rules** — correct and
  complete, but pulls in the eslint stack the repo has so far avoided, and adds a
  slow (type-aware) lint pass.
- **(c) leave it as convention** — the 7 sites all handle failure correctly today;
  a code-review checklist item + the small site count may be enough.

**Recommendation for class 3: (a) start with the ast-grep syntactic proxy**, and
only reach for (b) if unhandled-fetch bugs actually recur. Flagged for the operator
on the PR thread.

### Adopt / Try / Skip

**Adopt (now):**

1. **A local `tsc` gate** (`pre-push` hook or `bun run` wrapper). Zero new deps,
   closes the most frequent bug class. *This is the single highest-value change in
   the spike.*
2. **A tiny ast-grep ruleset** (~4 rules): `no-raw-window-open` (the missing desktop
   guard) plus, optionally, ports of `lint-dock-theme` and `lint-spacing`. Wire
   `ast-grep scan` into `bun run check` next to the existing scripts.

**Try (non-gating first, behind the `check` script or a separate CI job):**

3. **knip**, scoped to `--include files,dependencies` with a config declaring entry
   points. It already found a real phantom dep (`@dnd-kit/utilities`) and a dead
   file (`plan-md-diff.ts`) — fix those regardless of whether knip is adopted.
4. **oxlint** as a fast supplementary `correctness`/`suspicious` pass — *not* as a
   biome replacement, and knowing it won't touch the fetch bug class.
5. **publint** at prepublish — one-line `license` fix now; guards future `bin`/
   `files` mistakes since we do publish.

**Skip:** type-coverage (strict already on; slow; test-cast noise), attw (we ship a
CLI, not a types library), dependency-cruiser (setup > payoff on this graph),
semgrep (wrong problem shape; ast-grep covers the custom-rule need).

### Which hand-rolled scripts a tool could replace

| Script | Replaceable by | Verdict |
|---|---|---|
| `lint-dock-theme.ts` | ast-grep (banned import from `dockview-react`) | **Yes** — a few lines of YAML. |
| `lint-spacing.ts` | ast-grep (banned numeric spacing prop) | **Yes** — a few lines of YAML. |
| `lint-strings.ts` | — | **No.** It reads the vocabulary *dynamically* out of `types.ts` and cross-references; hardcoding the enum values into a static rule would defeat the single-source-of-truth. Keep it. |

Consolidating the two replaceable scripts into ast-grep isn't urgent — they work and
are unit-tested — but doing it *alongside* adding the `window.open` guard means one
engine, one escape-hatch convention (`// ast-grep-ignore`), and one place for future
banned-construct rules, rather than a new bespoke scanner per rule. That, plus the
`tsc` pre-push gate, is the whole recommendation.

### Concrete follow-ups worth filing regardless

- Add `@dnd-kit/utilities` to `package.json` dependencies (currently phantom/transitive).
- Add `dockview-core` (or stop importing its CSS path directly) — currently relied on transitively.
- Delete or wire up `src/web/plan-md-diff.ts` (dead).
- Add the `"license"` field to `package.json` (publint).
