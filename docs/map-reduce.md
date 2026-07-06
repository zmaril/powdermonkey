# Map-reduce shaped work in PowderMonkey

A spike into where a map-reduce pattern already exists in this codebase, and where
adding one would close a real gap. Written the same way as
[completion-model.md](completion-model.md): survey, then a recommendation.

## What "map" and "reduce" mean here

PowderMonkey is fundamentally about fanning work out across repos/sessions
(**map**) and folding the results back into one board (**reduce**). That shape
shows up three times already — twice built, once missing.

## Already built

### 1. Task fan-out (map, authoring-time)

[`fanout.ts`](../src/server/fanout.ts) is the clearest map in the codebase: author
one task spec (title, kind, description, phases) and stamp it across N repos in a
single transaction, one task per repo, all sharing the milestone. `POST /fan-out`
is the entry point; the multi-select repo picker (`SelectionBar.tsx`) feeds it. See
[vocabulary.md § Task](vocabulary.md#task).

### 2. Reconcile / PR-watch across repos (map + reduce, in-flight)

[PR #70](https://github.com/zmaril/powdermonkey/pull/70) ("Multi-repo reconcile &
PR watch", currently draft) does both halves for a different concern — the
same `main` scan run per registered repo (map), unioned into one
`ReconcileResult`/PR-store (reduce):

- `reconcile.ts` now loops every live registered repo, `git fetch`es its cache
  clone, scans `origin/<defaultBranch>` for `PM-Phase:`/`PM-Task:` trailers, and
  unions the hits with the legacy supervisor-checkout scan.
- `github-watch.ts` runs its GraphQL PR query per repo and keys PRs by
  `(repo, number)` instead of assuming one global slug.

This is exactly the map-reduce shape — independent per-repo work, joined into a
single source of truth the board reads — it's just not named that anywhere. Worth
knowing about before reinventing it: if more per-repo polling shows up (e.g. CI
status, branch protection checks), the pattern to reach for is "loop registered
repos, union by a stable key," not a bespoke loop per feature.

## The gap: fan-out has no reduce

Fan-out (map) has no counterpart. Once "add the linter to three repos" becomes
three tasks, nothing links them back together except sharing a `milestoneId` and
`title` — there's no `fan_out_id` or group key on the `tasks` row
([`schema.ts:57`](../src/server/schema.ts)). Concretely, today:

- There's no way to ask "how did the three siblings of this fan-out actually
  turn out" beyond eyeballing the milestone's task list — no single synthesized
  answer to "did the linter land the same way in all three, and what differed."
- A milestone's rollup only ever counts phases done/total (see
  [completion-model.md](completion-model.md)) — a percentage, not a summary. Three
  siblings all `merged` says nothing about whether repo B needed a different
  config or repo C's PR got extra review comments worth knowing about.
- Nothing closes the loop back to the operator when a fan-out finishes — they'd
  have to notice all three cards went green on their own.

This is the same shape as the deep-research pattern (fan out N searches, verify,
synthesize one report) and the `Workflow` tool's `pipeline`/`parallel` +
judge-panel idea already available in this environment — PowderMonkey has the
map half of that pattern but not the reduce half.

## Proposed reduce step

Add a **fan-out group key** and a **reduce action** on top of it:

1. **Schema.** Give `fanOutTasks` a `fanOutId` (a UUID or the batch's own first
   task id) stamped on every sibling row it creates. Purely additive — nullable,
   like `decisionSource` — so ungrouped tasks are unaffected.
2. **Reduce endpoint.** `POST /fan-out/:fanOutId/reduce` (or an automatic trigger
   once every sibling reaches `merged`/`cancelled`): read each sibling task's PR
   description/diary/comments, and produce one synthesized note — what happened
   in each repo, what differed, anything that needs the operator's attention.
   Following the "supervisor never executes work, only speaks through the API"
   boundary, this would be a **supervisor-authored task comment or note**, not a
   commit — same shape as the existing `author: "supervisor"` diary lines
   ([powdermonkey skill § Task comments](../.claude/skills/powdermonkey/SKILL.md)),
   not a new completion path.
3. **Surface it.** Once all siblings are terminal, show the synthesized note on
   the milestone (or the first sibling task) instead of just three green cards —
   this is the piece that actually closes the loop for the operator, who
   otherwise has no reason to go look.

This mirrors the completion-model's provenance approach: additive, doesn't touch
the existing done/rollup math, and keeps the reduce step clearly attributed
(`source: "supervisor"`) rather than disguised as reconciled progress.

## Open question for the operator

Is a `fanOutId` group key worth adding to `tasks` for this, or is milestone-level
grouping (treat "all live tasks under this milestone with this exact title" as
the group) good enough without a schema change? The former is more precise (two
fan-outs with the same title in one milestone stay distinguishable) but touches
the schema; the latter is zero-migration but fuzzier. Flagged on the PR — happy to
build either once you weigh in.
