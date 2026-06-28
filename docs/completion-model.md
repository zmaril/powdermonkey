# Non-reconciled completion

## The problem

PowderMonkey's central invariant is that **progress is read off `main`, never
self-reported**. A phase or task only becomes "done" when the reconciler
([`src/server/reconcile.ts`](../src/server/reconcile.ts)) scans the commits
reachable from `main`, finds a `PM-Phase: <id>` / `PM-Task: <id>` trailer, and
ticks the matching rows. The skill spells this out as a rule: *"Don't fake
progress. Never `PATCH` a phase to `status: done` to finish work — reconciliation
is the source of truth."*

That invariant is the whole point of the system — it's what lets a session roam
across goals and a task span several PRs without anyone trusting a worker's
word. But it has a blind spot. **Some legitimately-finished work never produces a
trailer on `main`, so the board can never show it done:**

1. **Trailer-less merges.** A squash merge collapses a PR's commits into one and
   can drop the `PM-Phase:` lines (README already flags this). The work lands;
   the phases stay open forever.
2. **Out-of-band work.** A phase satisfied by a commit that predates PowderMonkey,
   done directly on `main`, or finished by hand outside any session. No trailer
   was ever written, and rewriting history to add one isn't worth it.
3. **Won't-do / obsolete.** The operator decides a phase or task is moot and wants
   it off the active board without inventing a fake commit to "complete" it.
4. **Phase-less tasks.** A task authored with no phases at all (this repo's own
   "Implement + surface it in the UI" task is one). Reconciliation can only close
   it via an explicit `PM-Task:` trailer; absent that, there is no grain to tick.

In every case the work is genuinely done (or genuinely closed), but the
reconciler — correctly — won't touch it, because nothing on `main` says so. We
need a model for **operator-asserted completion**: a way to close work that is
*not* derived from `main`, without corroding the "main is the truth" invariant
that makes the rest of the board trustworthy.

## The options

Three models were surveyed.

### A. Provenance field

Keep `status` as the single todo/done axis the rollups already read, and add a
nullable **`done_source`** column recording *how* a row reached done:
`reconciled` (a trailer on `main`, written by the reconciler) or `operator` (the
operator asserted it in the UI). The column is pure attribution — it never
changes the progress math, only labels each completion by origin.

- **For.** One done axis means zero churn in rollups (`rollup()` still just
  counts `status === done`) and in every `=== Done` check across server and UI.
  It's *honest*: an operator assertion is visibly a different thing from work
  that landed on `main`, so "don't fake progress" sharpens into "don't fake
  *reconciled* progress — operator-done is its own labelled category." The
  migration is one nullable column, exactly the additive style the schema already
  uses. Reconciliation stays authoritative: it sets `done_source = reconciled`
  and may *upgrade* an operator-asserted phase if a real trailer later lands
  (truth supersedes assertion), but never silently un-does operator work.
  Auditability is preserved — you can always filter "what's actually on `main`"
  from "what I asserted by hand."
- **Against.** A second dimension to carry through the completion paths: the
  reconciler must set it, and the UI must render two done-styles instead of one.

### B. Retro-trailer commits

To close non-reconciled work, have the supervisor write a synthetic empty commit
to `main` carrying `PM-Phase: <id>`, then let the normal reconciler pick it up.
One completion path, one source of truth, no schema change.

- **For.** No new model at all; the invariant stays *literally* true (everything
  done really is on `main`), and the completion is recorded in history.
- **Against.** It **violates the supervisor boundary** — "the supervisor runs on
  `main` and never executes work itself"; committing to `main` is exactly
  executing work, and it's a heavy, dangerous operation (clean-tree requirement,
  push auth, possible conflicts, history pollution with empty commits). Worse, it
  **launders** an operator assertion into looking like landed work, destroying the
  asserted-vs-landed distinction that makes the board trustworthy. It doesn't fit
  the won't-do case (you'd be fabricating a completion for work that was never
  done), and undoing one means yet another commit. Far too much machinery for a
  tool whose own design doc expects it to be obsolete in ~3 months.

### C. Operator-done status

Add a distinct status value — e.g. `PhaseStatus.OperatorDone` separate from the
reconciled `Done` — and let the operator set it directly. The done-origin
distinction lives in the status enum itself, so no new column.

- **For.** No extra column; one place to look to see how a row was completed.
- **Against.** It splits "done" into two values that *every* consumer must now
  treat as done. `rollup()` counts only `Done` and would silently undercount;
  every `=== Done` check (the reconciler's `ne(status, Done)` guard, the UI's
  `PhaseList` glyph, the progress math) has to become a set-membership test, and
  forgetting one is a quiet, hard-to-spot bug. It conflates two orthogonal axes —
  *is it done* × *who said so* — into a single enum, which is precisely the
  modelling smell the codebase works to avoid elsewhere (e.g. the
  `pull_requests` row deliberately keeps "observed cache" and "ledger" columns
  apart). And the reconciler and the operator would contend over one column.
