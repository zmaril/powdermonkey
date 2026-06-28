# Typed strings, not stringly-typed meaning

PowderMonkey speaks a small set of **closed vocabularies** — a session is
`local` or `remote`, a phase is `todo` or `done`, a PR is `OPEN`/`CLOSED`/`MERGED`,
and so on. Each of those is declared once, as an `as const` object in
[`src/shared/types.ts`](../src/shared/types.ts), and its type is derived from the
object so there is exactly one place to add or rename a member. The Drizzle
columns are `$type<…>()`-constrained to those unions, and the server/UI fan out
from there. `ts-pattern`'s `match(...).with(Enum.Member, …)` then gives us
*exhaustive* handling — add a member and the unhandled `match` is a compile error.

## The rule

**Function arguments and parameters must not be loose strings.** Where a value
belongs to one of these vocabularies, the code must say so with the type — an
enum member or a declared string-literal union — not a bare `string` annotation
or a magic string literal:

```ts
// ✗ stringly-typed: the meaning lives in a string the compiler can't check
function rebaseAction(mergeable: string | null) { ... }
if (row.state === "stopped") { ... }
const [running, setRunning] = useState<"local" | "remote" | null>(null);

// ✓ typed: the vocabulary is the type, and the enum member is the value
function rebaseAction(mergeable: MergeableState | null) { ... }
if (row.state === SessionState.Stopped) { ... }
const [running, setRunning] = useState<SessionKind | null>(null);
```

Declared string-literal unions (`type CloudEventType = "pr.opened" | …`) are
fine — the meaning is named and the compiler enforces the set. What the rule
rejects is the *bare* literal: `"stopped"` spelled out at a call site or
comparison when `SessionState.Stopped` already exists for it.

## How it's enforced

A small custom lint, [`scripts/lint-strings.ts`](../scripts/lint-strings.ts),
reads the enum vocabularies out of `src/shared/types.ts` and flags any string
literal elsewhere in `src/` whose value is a member of one of them — i.e. a
magic enum string that should be the enum member instead. It runs as part of
`bun run check` (alongside `biome`), so CI fails on a regression.

There is no off-the-shelf rule for this — biome (the project's only linter) has
no custom-rule support in the pinned version, and pulling in eslint + a
type-aware parser just for one rule is more machinery than the check is worth.
The custom scan is deterministic, dependency-free, and targets exactly the smell
we care about: the closed vocabularies leaking back out as bare strings.

### Intentional exceptions

A few string literals legitimately *equal* an enum value without being one — a
display label, a UI `title`, a database column name. Mark those with a
`// lint-allow-string: <reason>` comment on the same line and the scanner skips
them. Keep the reason honest; the comment is the audit trail for why a string
that looks like an enum value isn't being made one.
