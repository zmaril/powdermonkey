# Map-reduce in PowderMonkey

> A spike. The deliverable is understanding: *how could PowderMonkey use
> map-reduce?* The short answer is that it already runs half of one, and the
> other half is a small, well-shaped addition. This note explains the mapping,
> what exists today, the gap, the use cases worth it, and a phased path.

## TL;DR

- Map-reduce is the native shape of PowderMonkey's job: **pour many agents over a
  problem, then pull the results back together.** The README says as much —
  "knowledge work is now a resource that you can pour over a problem."
- PowderMonkey already ships **the map half** as **task fan-out**
  (`src/server/fanout.ts`): author one task spec, stamp it across N repos, run N
  parallel sessions.
- It already ships **a reduce half** as **reconciliation**
  (`src/server/reconcile.ts` + `completion.ts`): fold `PM-Phase:` / `PM-Task:`
  trailers off `main` up the `Phase → Task → Milestone → Goal` tree.
- The gap: today's fan-out only maps over **repos**, and today's reduce only
  folds **progress** (done/not-done booleans), never the **work products** (the
  PRs/outputs). A "true" map-reduce needs (a) fan-out over an arbitrary key, and
  (b) a **reduce task** that waits for the map set and synthesizes their outputs.
- Recommended first step: generalize fan-out from "one repo per task" to "one
  **item** per task," and add a **reduce task** that depends on a fan-out set.
  Everything else — the parallel sessions, the roll-up, the book of work — is
  already there.

## Why the shape fits

PowderMonkey exists to coordinate "many agents working together towards related
yet disparate goals" (`README.md`). That is map-reduce stated in prose:

- **Map** — take one shape of work and apply it independently across a set of
  inputs, each in its own isolated environment, all in parallel. In PM that's a
  **Session** per **Task**, each isolated (a `pm/task-<id>` worktree or a
  `claude --remote` sandbox), landing on `main` independently.
- **Reduce** — combine the parallel results into one answer. In PM that's
  **reconciliation** folding trailers up the tree, and (not yet) a **synthesis
  step** that reads the map outputs and produces a combined artifact.

The vocabulary is already close to a dataflow: `Goal → Milestone → Task → Phase`,
with a **Session** that is deliberately *independent of the hierarchy* and can
"complete phases across many goals" (`design.md`, `schema.ts:108`). A session is
already the worker in a work queue; tasks are already the units it maps over.

## What already exists

### The map half — task fan-out

`src/server/fanout.ts` is a map primitive. `fanOutTasks()` takes **one** task
spec (title, kind, description, phases) and a **set** of `repoIds`, and in a
single transaction writes **one task per repo** under a milestone:

```ts
// fanout.ts — "author ONE task spec and stamp it across N repos at once,
// one task per repo, all sharing the milestone/title/phases."
for (const [i, repoId] of repoIds.entries()) {
  const [t] = await tx.insert(tasks).values({ ..., repoId, position: base + i }).returning();
  if (phaseInputs.length > 0) await tx.insert(phases).values(/* copy of phases */);
}
```

This is the "add the linter to three repos" story from `docs/vocabulary.md`: pick
N repos in the task picker, get N sibling tasks, dispatch N cloud sessions. The
**map key is the repo.** Each fanned task is then dispatched independently
(`dispatch.ts`), so the parallel-execution machinery is already in place.

### The reduce half — reconciliation

`src/server/reconcile.ts` is a fold. It scans every commit reachable from `main`
for `PM-Phase:` / `PM-Task:` trailers and folds completion up the tree:

- phase trailers → mark phases done (`reconcile.ts:121`),
- a task's phases all done → roll the **task** to `merged` (`reconcile.ts:169`),
- `completion.ts` mirrors the same roll-up for operator/supervisor overrides.

It's **idempotent**, runs on a poll loop, and is the single source of truth for
"what actually happened." That is exactly a reduce's contract: associative,
re-runnable, driven by the inputs (commits on `main`) rather than by workers
self-reporting.

The many-to-many `session_tasks` join (`schema.ts:132`) even lets **one session
reduce across many tasks** — "one worker, one combined brief" — which is the
combiner pattern (one reducer consuming several map outputs).

## The gap: what's missing for a "true" map-reduce

Two concrete things separate today's fan-out + reconcile from a general
map-reduce:

1. **Map only ranges over repos.** `fanOutTasks` keys strictly on `repoIds`
   (`fanout.ts:16`). Real map-reduce work often fans over a *different* axis:
   files in a directory, modules in a monorepo, rows of a checklist, N candidate
   designs, a list of failing tests. There is no way to say "fan this task over
   *these items*" unless each item happens to be a repo.

2. **Reduce folds progress, not outputs.** Reconciliation combines **booleans**
   (phase done?) — it never reads the **work** the map sessions produced (their
   PRs, their diffs, their findings) and synthesizes a combined artifact. And
   nothing **waits** for the whole map set before running a synthesis step:
   there's no dependency/barrier between tasks. A "reduce this PR cluster into one
   summary / one merged change / one decision" step has nowhere to live.

Put differently: PM has **scatter** (fan-out) and **progress-gather**
(reconcile), but not **output-gather** (a reduce task that runs *after* and
*because of* the map set, consuming its results).

## Use cases, ranked by payoff

1. **Codebase-wide sweeps (map over files/modules).** "Apply this refactor to
   every file in `src/web`," "add a test per route," "migrate each package off
   the deprecated API." Map = one session per file/module (isolated, parallel);
   reduce = a consistency pass + a single roll-up PR or a summary of what each
   changed. This is the fan-out generalized off the repo axis — highest payoff,
   most natural fit.

2. **Multi-repo pushes (map over repos — already supported).** "Add the linter to
   three repos." Already works via fan-out; the missing piece is a reduce task
   that reports "3/3 landed, here's the combined changelog."

3. **Fan-out research / audit (map over questions, reduce = synthesis).** Mirrors
   the `deep-research` and `code-review` skills already in this repo: map many
   independent investigators over subsystems/questions, reduce by
   adversarially verifying and synthesizing a cited report. A **spike** whose N
   phases each dispatch a reader, plus a reduce task that writes the summary.

4. **Multi-approach design (map = N attempts, reduce = judge panel).** Dispatch N
   sessions that each attempt the same task from a different angle, then a reduce
   task scores them and synthesizes the winner (grafting the best of the
   runners-up). Turns "press Try Again" into a structured tournament.

5. **Batch triage (map over issues/failing tests).** One session per failing test
   or open issue; reduce = a ranked, deduped report of what's fixable and what
   isn't.

## A phased path (minimal, additive)

Nothing here requires a new execution engine — the sessions, the isolation, and
the roll-up already exist. The additions are two: a **map key** and a **reduce
task**.

### Phase A — generalize fan-out from repos to items

Let a fan-out range over an arbitrary list of **items** (strings: file paths,
module names, question prompts), not just `repoIds`. Each item becomes a sibling
task whose description is templated with the item (e.g. `description` gains the
item, phases stay pure work). Repos stay orthogonal — an item-fan-out still pins
one repo per the existing rule. This is a small change to `fanout.ts`'s input
shape plus the authoring UI's picker.

### Phase B — a reduce task with a dependency barrier

Introduce a task that **depends on** a fan-out set and only becomes dispatchable
once every task in the set has reconciled to `merged`. The supervisor's poll loop
already knows when tasks merge (`reconcile.ts:169`), so the barrier is a query,
not new infrastructure. When the barrier clears, the reduce task is auto-
dispatched with a brief that lists the map tasks' PRs/outputs to synthesize.

This is the one genuinely new concept: **task dependencies** (a DAG edge), which
PM does not model today. Keep it minimal — a single "reduces" edge from a task to
a fan-out group is enough for every use case above; a general task DAG is not
needed.

### Phase C — surface it in the tree

A fan-out group + its reduce task render as a labeled cluster in the plan tree
(the roll-up already aggregates phase progress). The reduce task's output (the
synthesis PR / report) is the map-reduce's return value, and lands in the book of
work like any other.

## Recommendation

PowderMonkey is **~70% of a map-reduce engine already** — it just isn't described
as one. The map (fan-out) and the progress-reduce (reconcile) are built and
dogfooded. To make map-reduce a first-class pattern, do the two additive things
above:

1. **Generalize fan-out** from "per repo" to "per item" (`fanout.ts`) — unlocks
   the codebase-sweep use case, the highest-value one.
2. **Add a reduce task** gated on a fan-out group's completion — the one new
   concept (a single dependency edge), reusing the existing merge signal.

Everything else — parallel isolated sessions, the roll-up, the book of work — is
reuse. Start with Phase A alone (it's valuable on its own and needs no new
concepts); take Phase B only when a real reduce step is in hand to justify the
dependency edge.

## Open questions for the operator

- **Is the target use case codebase sweeps (map over files) or research fan-out
  (map over questions)?** Both fit; they prioritize Phase A vs. Phase C
  differently.
- **How much reduce is wanted?** "Report what landed" (cheap — reconcile already
  has the data) vs. "synthesize a combined artifact" (needs the reduce task in
  Phase B).
- **Is a task dependency edge acceptable?** It's the only new concept and cuts
  against the current "sessions roam freely, nothing blocks" model. Worth
  confirming before building Phase B.
