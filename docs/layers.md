# Nervo · Immersion · hosts — design

Describe your domain's *moves* once — entities, lifecycles, actions with a meaning and a cost —
and let every surface render them: a button in the shell, a verb in a CLI, a tool an agent calls.
**Nervo** is an action catalog + a dispatch engine; **Immersion** is a shell that renders any
catalog; a **host** is a domain that supplies one.

Status: design; first vertical built (the core, two hosts, the boundary lint — on this branch).
First host + dogfood: PowderMonkey itself. Sibling design:
[fluessig](https://github.com/zmaril/entl/blob/main/crates/fluessig/DESIGN.md) makes the same
move one layer down — *data shape* rather than *behavior* — and the two docs deliberately rhyme:
authored source → resolved catalog → dumb consumers, a fixed change protocol in the middle,
capability-honest back-ends.

---

## 1. What it is (and isn't)

Three layers over **one** action model:

1. **Nervo** (`src/nervo/`) — the headless agentic core. An **XState-backed** FSM engine
   (`fsm.ts`), a command bus (`bus.ts`), undo/history (`history.ts`), and the proposals model
   (`proposals.ts`, generalized from `server/proposals.ts` + `apply.ts`). Domain-agnostic: knows
   nothing about plans, git, or the DOM. Grows toward co-pilot logic and agent-runtime plugins.
2. **Immersion** — the Blender-like presentation: windows / panes / dockview, the co-pilot pane,
   proposal cards, highlights. Today `src/web/**`. A renderer of whatever a host + Nervo expose —
   it owns *presentation*, never an action's meaning.
3. **A host** — the domain. PowderMonkey (plan model, dispatch, reconcile —
   `src/server/**` + `src/shared/types.ts`, with `src/host/powdermonkey.ts` as its contract) is
   the first; a Word document (`examples/word-host.ts`) is the proof the core is domain-agnostic.

It is **not**: a UI framework, a database, or a workflow engine. Nervo executes no effects and
holds no state — `dispatch` emits a validated, priced `Transaction` and the caller applies it
(the same pure-library discipline as fluessig/entl-core: emit artifacts, never do I/O).

**The seam — the one rule the split rests on:**

> **Nervo imports neither Immersion nor any host's schema.** Immersion and every host depend
> *inward* on Nervo. The arrows only point down.

Enforced from day one — before any packaging — by
[`scripts/lint-boundaries.ts`](../scripts/lint-boundaries.ts), wired into `bun run check`. It
fails the build if anything under `src/nervo/**` imports `src/web` (Immersion), `src/server` /
`src/shared` (the plan schema), or any npm dependency outside the core's allowlist (exactly
**XState**). The example host is held to the same test a third party would be: Nervo + XState
only. Escape hatch, same as the other lint scripts: a same-line
`// lint-allow-boundary: <reason>`.

### Why XState — the decision record

The first cut hand-rolled transition maps plus `onlyFrom`/`notFrom` permit closures — which
duplicated the FSM's edges in guard logic, the exact smell the engine exists to kill. XState was
chosen because: a statechart is **data** (`createMachine(json)` round-trips, so machines are
catalog-ready, not code-locked); its pure snapshot API (`getInitialSnapshot` / `getNextSnapshot`)
computes transitions without actors, keeping the core side-effect-free; and the machine owns the
transition table, so an illegal move is rejected by the machine, not a hand-rolled guard. Cost
accepted: one sanctioned dependency in the core, named in the boundary lint's allowlist.

### Locked decisions

| Decision | Choice | Consequence |
|---|---|---|
| The seam | one-way: hosts + Immersion depend inward on Nervo | `lint-boundaries.ts` in `bun run check`; violations fail the build |
| FSM engine | XState, pure snapshot API, no actors | lifecycle legality is the machine's job; permits are extra-FSM guards only |
| Core dependencies | exactly `xstate` | allowlisted in the lint; anything else is a violation |
| Action meaning | lives on the catalog entry (`id`, `title`, `event`, cost) | surfaces are projections; no surface owns a label |
| Dispatch protocol | fixed, Nervo-defined, **not authored** | `Transaction { action, before, after, cost }`; hosts author catalogs, never the protocol |
| Packaging | deferred until a second real host appears | a one-way door we can open later, not one to hold open now |

---

## 2. The core question: what is an action?

An action's **label and meaning belong to the action, not to any surface.** "Dispatch remote" is
the meaning; a button is one projection of it, a CLI verb another, an agent's tool call a third.
Today that meaning is spelled in ~four disconnected places (button text, store method name, route
path, catalog title), kept in sync by hand. The model collapses them: the catalog is the
registry; everything else renders it.

### The host interface (what a host authors)

A host supplies a `HostContract` ([`contract.ts`](../src/nervo/contract.ts)):

1. **Entity/FSM definitions** — an XState machine per entity kind. Nervo steps these; the
   machine owns which moves are legal.
2. **An action catalog** — named moves against an entity kind. Each sends one XState *event*
   and carries its meaning (`title`) and its **cost spec** (`{unit, amount}` in whatever unit the
   host meters — a cloud run, a worktree).
3. **Permission specs** — per-action guards for what the lifecycle *can't* express (a budget, a
   param check). Lifecycle gating itself is never a permit's job.

The modeler declares *intent*; each **surface decides the presentation** — the same
intent/projection split as fluessig's "each codec decides the physical shape."

### The dispatch protocol (fixed, not authored)

Nothing about this appears in a host's contract; it is Nervo-defined and merely *typed by* the
catalog. `dispatch(host, entity, actionId, params)` resolves the action, runs the permit, asks
the machine whether the event is legal from the entity's current state, prices the cost, and
emits a **`Transaction`** — before/after entities plus cost — mutating nothing. `available(host,
entity)` returns the moves that could fire right now: the affordances, pre-filtered by lifecycle
and permission, which is what any surface renders. `History` is a two-stack undo over
transactions (a transaction carries its own `before`). The proposals model groups a
create-subtree into one decidable unit — the same invariant family as fluessig's
"a composition aggregate is never split across Steps."

### How one catalog projects to every surface

| Catalog construct | UI (Immersion) | CLI | Agent (MCP) |
|---|---|---|---|
| `title` | button / menu label | verb help text | tool description |
| `available(entity)` | which buttons render enabled | which verbs apply | which tools are offered |
| params schema | form fields | flags | `inputSchema` |
| cost spec | confirm affordance | `--yes` prompt | budget check |
| permit refusal / illegal move | disabled + reason tooltip | non-zero exit + message | tool error |
| `Transaction` | optimistic update + undo | printed JSON result | tool result |

An action-catalog entry is isomorphic to an **MCP tool definition** (`name`, `title`,
`description`, input schema) — the agent surface is a near-mechanical translation, not a design
problem. The control-plane shape this implies is **registry + generic invoke** (three endpoints:
list the catalog, list an entity's available moves, invoke by id) — *not* a bespoke route per
verb, which is the drift the registry exists to kill. See prior art (§6).

---

## 3. Architecture — catalog at the center

```
 AUTHORING (front-ends)             INTERCHANGE              CORE                    SURFACES (projections)
┌─────────────────────────┐   ┌────────────────────┐   ┌──────────────────┐   ┌────────────────────────────┐
│ defineHost({...})  (TS) │──▶│                    │   │ loader/validator │──▶│ Immersion (buttons, panes) │
│                         │   │  nervo.host.json   │──▶│ FSM engine       │──▶│ MCP server (agent tools)   │
│ .tsp + @nervo/typespec  │──▶│  (planned:         │   │ command bus      │──▶│ CLI verbs                  │
│  (later, per fluessig's │   │   versioned,       │   │ history          │──▶│ generic-invoke HTTP        │
│   consumption model)    │   │   fingerprinted)   │   │ proposals        │   └────────────────────────────┘
└─────────────────────────┘   └────────────────────┘   └──────────────────┘    OBSERVERS (world → events)
                                                                                reconcile (PM-Phase trailers)
                                                                                agent status comments
```

- **Front-ends are dumb; the loader validates** (fluessig decision #8, adopted): every semantic
  rule — each action's entity exists, each event lands somewhere in its machine — lives in one
  core validator, so `defineHost`, a future manifest loader, and a future `.tsp` emitter all pass
  through the same checks. `defineHost` is the first front-end, not the format.
- **The manifest is the interchange** (planned): a `HostContract` serialized — machines as XState
  JSON, actions as records, static costs as data. Versioned and fingerprinted so a cached CLI
  verb list or MCP tool list can *detect* staleness rather than silently drift (fluessig's
  `_fluessig_meta` move).
- **Observers are the binding for agents that don't know Nervo exists.** PowderMonkey already has
  two: the reconciler (reads `PM-Phase:` trailers off `main`, fires phase transitions) and the
  agent-status watcher (parses a status word from a PR comment into a typed state). Both are
  `observation → event` adapters — reality is the source of truth, exactly the after-image /
  state-not-events posture fluessig's Layer C argues for.

---

## 4. What's built vs. what's modeled

**Built (this branch):** the core (`fsm` / `bus` / `history` / `proposals` / `contract`); the
PowderMonkey host (real task/phase/session machines + operator actions); the Word example host;
the boundary lint; tests running **one engine against both hosts** — the executable
domain-agnosticism proof.

**Modeled, not built** (specced so the contract doesn't preclude them; non-binding until built):
the manifest emit/load + fingerprint; the MCP binding; the generic-invoke control plane in PM;
**capability profiles** (each binding declares what it can honestly execute — checked at bind
time, so "this surface can't do that" is an error, never a dead button or a silently-ignored
verb); co-pilot logic and agent-runtime plugins.

Where today's PowderMonkey code lands:

| Layer | Concept | Where it lives today |
|---|---|---|
| **Nervo** | FSM engine, command bus, undo, proposals, host contract | `src/nervo/**`; the proposals model also lives in `src/server/proposals.ts` + `apply.ts`, which `src/nervo/proposals.ts` generalizes |
| **Nervo** | co-pilot logic, agent-runtime plugins | aspirational — the supervisor agent and `src/server/dispatch.ts` are the seeds |
| **Immersion** | windows / panes / dockview, proposal cards, highlights | `src/web/windows.ts`, `src/web/panes/**`, `src/web/PaneShell.tsx`, the dock/theme machinery |
| **host** | plan model, dispatch, reconcile | `src/server/**`, `src/shared/types.ts`; contract in `src/host/powdermonkey.ts` |

---

## 5. Build order — spine first, then fan out

1. **Core + two hosts + boundary lint** — done (this branch).
2. **Manifest** — emit `nervo.host.json` from a `HostContract`; core loader + validator +
   fingerprint. Front-ends become printers.
3. **MCP binding** — catalog → tools, proven against *both* hosts; makes "any host is
   agent-drivable" executable rather than rhetorical.
4. **Control-plane consolidation in PM** — `GET /actions`, `GET /:kind/:id/actions`,
   `POST /actions/:id`; today's bespoke verb routes (`/complete`, `/dispatch`, `/cancel`, …)
   become effect handlers behind the one door. **Parity-gated**: reproduce existing behavior
   exactly, assert it, and only then delete — the entl/fluessig dogfood discipline.
5. **Immersion renders from the catalog** — buttons read `title` + availability instead of
   hardcoding labels; a command palette falls out for free.
6. **Fan out** — CLI verbs off the catalog; a second real host; *then* packaging.

---

## 6. Non-goals (v-now) & prior art

Non-goals: no query/read layer (reads are the `/sync` collections — Nervo owns *moves*, not
views); no effect execution in the core (it emits Transactions; hosts execute); no TypeSpec
front-end yet (decision log); no packaging until a second real host.

Prior art the design stands on:

- **Blender operators** — the namesake pattern: `bl_idname` / `bl_label` / `poll()` /
  `execute()`; the UI renders the registry (`layout.operator("mesh.subdivide")` pulls label,
  tooltip, enabled-state), keymaps and Python drive the same names, operators feed the undo
  stack. Nervo's catalog *is* this, extracted.
- **VS Code commands** — command id + contributed title; palette, menus, keybindings, extensions
  all project one registry; `executeCommand(id, args)` is the generic invoke.
- **LSP / MCP** — discovery + generic invoke over JSON-RPC; MCP's `tools/list` → `tools/call` is
  the catalog protocol Nervo's agent surface will speak natively.
- **Hypermedia (Siren/HATEOAS)** — the server ships each entity's currently-available actions;
  `available()` as an API response.
- **Kubernetes** — the declarative counterpoint: PM's reconciler already *is* level-based
  reconciliation (progress is read off `main`, never self-reported), and stays that way; only the
  irreducible verbs ride the command bus. K8s's `scale`/`eviction` subresources concede the same
  split.
- **fluessig** — the sibling: authored source → resolved catalog → validating loader → dumb
  projections, a fixed non-authored change layer (its Layer C ↔ Nervo's dispatch protocol — both
  independently named the atomic unit **Transaction**), capability profiles, fingerprint drift
  detection, parity-gated dogfood. Where fluessig models what a domain *is*, Nervo models what
  you can *do* to it.

---

## 7. Decision log & remaining opens

Resolved:

1. **Boundary before packaging** — the seam is drawn and lint-enforced first; the package split
   waits for a second real host (the same "one-way door" posture as fluessig's catalog format).
2. **XState backs the FSM engine** — statecharts-as-data, pure snapshot API; the core dependency
   allowlist is exactly `xstate`.
3. **Lifecycle gating belongs to the machine** — permits exist only for guards the FSM can't
   express; the first cut's `onlyFrom`/`notFrom` closures were deleted for duplicating edges.
4. **Meaning lives on the action** — `title`/cost/event are catalog fields; UI, CLI, and agent
   surfaces are projections and own no labels.
5. **Control-plane shape: registry + generic invoke** — three endpoints, not method-per-action;
   bespoke verb routes are a migration target, not a pattern to extend.
6. **TypeSpec front-end: deferred, with the language question settled** — if/when host contracts
   are authored outside TS, the front-end is TypeSpec + a `@nervo/typespec` decorator lib
   emitting the same manifest, per fluessig's spike-proven consumption model (dumb emitter walks
   the checked program; validation stays in the core loader). fluessig's §1 decision record
   (typed decorators with checked references beat YAML/JSON/SDL string-DSLs) transfers verbatim;
   do not re-litigate. Trigger: a non-TS host author, not before.
7. **Observers are a first-class binding** — an agent that never calls Nervo is driven by
   `observation → event` adapters (reconcile, status comments); state-not-events, after-images
   only.

Still open:

- **Effect bindings** — how a catalog entry names its *effect* (today: the imperative route/store
  code keyed by the same id, disconnected from the catalog). Working hypothesis: **capability
  profiles** (fluessig Layer C) — each binding declares which actions it can execute and how
  atomically, checked at bind time. Decide during build-order step 4, when PM's real routes are
  in front of us.
- **Manifest closure policy** — `permit`/`cost`/`event` accept function forms in TS; the manifest
  must pick: reject closures, restrict to static data (the PM host is already fully static), or
  a declarative predicate subset. Leaning: static-data-only for v1, predicates later.
- **Co-pilot logic & agent-runtime plugins** — named in the layer map, shape undefined; the
  supervisor agent and `dispatch.ts` are the seeds. Non-binding until a design pass.
- **Idempotent invoke** — a CLI retry must not dispatch twice; idempotency key vs. the
  writer-lock claim pattern already in `apply.ts`.
- **fluessig convergence** — one `.tsp` carrying shape (fluessig decorators) *and* behavior
  (nervo decorators), two emitters, two catalogs, one source of truth. Real but speculative;
  reserved so decorator namespacing and catalog versioning don't foreclose it. Neither project
  builds ahead of its dogfood for the other.
