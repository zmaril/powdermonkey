# Three layers: Nervo, Immersion, and the host

PowderMonkey is being drawn as three layers with an honest, one-way seam between them,
so the two general parts can eventually be reused on their own:

- **Nervo** — the headless agentic core. A domain-agnostic engine: a typed action
  protocol, a command bus, undo/history, an FSM engine (built on **XState**), the
  proposals model, and (as it grows) co-pilot logic and agent-runtime plugins. Knows
  nothing about plans, git, or the DOM.
- **Immersion** — the Blender-like presentation. Windows / panes / dockview, the co-pilot
  pane, proposal cards, highlights. A shell that renders whatever a host + Nervo expose.
- **The host** — the domain. PowderMonkey's plan model, dispatch, and reconcile. The first
  host; a Word document (`examples/word-host.ts`) is the proof the core is domain-agnostic.

```
        ┌──────────────┐        ┌──────────────────────────┐
        │  Immersion   │        │  host (PowderMonkey, …)   │
        │  (the shell) │        │  plan · dispatch · reconcile │
        └──────┬───────┘        └────────────┬─────────────┘
               │  depends inward             │  depends inward
               ▼                             ▼
        ┌──────────────────────────────────────────────────┐
        │                     Nervo                          │
        │  action protocol · command bus · undo/history ·    │
        │  FSM engine · proposals · (co-pilot, agent runtime)│
        └──────────────────────────────────────────────────┘
                 Nervo imports NEITHER of the two above.
```

## The seam, and how it's kept honest

The one rule the whole split rests on:

> **Nervo imports neither Immersion nor any host's schema.** Immersion and every host
> depend *inward* on Nervo. The arrows only point down.

This is enforced from day one — before any packaging — by
[`scripts/lint-boundaries.ts`](../scripts/lint-boundaries.ts), wired into `bun run check`
alongside the repo's other custom lint scripts. It fails the build if anything under
`src/nervo/**` imports `src/web` (Immersion), `src/server` / `src/shared` (the plan
schema / host domain), or any npm dependency outside the core's small allowlist. That
allowlist is exactly **XState** — the FSM engine Nervo is built on; nothing else. The
example host is held to the same test a third party would be: it may import only Nervo and
XState.

The escape hatch is the same as the other lint scripts: a same-line
`// lint-allow-boundary: <reason>`.

## The host interface Nervo consumes

A host is a domain that plugs into Nervo by supplying a `HostContract`
([`src/nervo/contract.ts`](../src/nervo/contract.ts)) — three things:

1. **Entity/FSM definitions** — a lifecycle per entity kind, as an **XState machine**
   ([`fsm.ts`](../src/nervo/fsm.ts) wraps XState's pure snapshot API). Nervo steps these;
   XState owns the transition table, so an illegal move is rejected by the machine, not a
   hand-rolled guard.
2. **An action catalog** — named, typed moves against an entity kind. Each sends one
   XState *event* into the entity's machine, and carries its own cost spec.
3. **Cost / permission specs** — attached per action, so the command bus can price a move
   ([`bus.ts`](../src/nervo/bus.ts)) or refuse it on a non-lifecycle guard, without knowing
   what the move *means*. Lifecycle gating itself is the machine's job.

In return the host gets the core: the command bus (`dispatch` / `available`), the FSM
engine, undo/redo (`History`), and the proposals model (`unitIndices` / `decide`).

**PowderMonkey is the first host** — [`src/host/powdermonkey.ts`](../src/host/powdermonkey.ts)
transcribes the app's real task / phase / session state machines and its operator actions
(dispatch, start-local, land, complete, cancel, reopen, …) as a `HostContract`. It imports
Nervo and PowderMonkey's own vocabulary; Nervo imports neither.

**A Word document is the proof** — [`examples/word-host.ts`](../examples/word-host.ts) drives
an entirely different domain (documents, review state, comment threads) through the exact
same core. It shares zero vocabulary with the plan. If Nervo leaked one plan-shaped
assumption, that file could not compile against it.
[`tests/nervo.test.ts`](../tests/nervo.test.ts) runs the same engine against both hosts —
the executable proof.

## Where today's code lands

The layers are being *drawn* before the code is physically moved (see "Packaging" below).
The map:

| Layer | Concept | Where it lives today |
|-------|---------|----------------------|
| **Nervo** | action protocol, command bus, FSM engine, undo, proposals | `src/nervo/**` (new); the proposals model also lives in `src/server/proposals.ts` + `apply.ts`, which `src/nervo/proposals.ts` generalizes |
| **Nervo** | co-pilot logic, agent-runtime plugins | aspirational — the supervisor agent and `src/server/dispatch.ts` are the seeds |
| **Immersion** | windows / panes / dockview, proposal cards, highlights | `src/web/windows.ts`, `src/web/panes/**`, `src/web/PaneShell.tsx`, the dock/theme machinery |
| **host** | plan model, dispatch, reconcile | `src/server/**` (schema, dispatch, reconcile), `src/shared/types.ts` |

## Packaging (deferred)

The layers do **not** get split into separate npm packages yet. Per the plan, that happens
*only once a second host appears* — until then a package boundary is overhead without a
consumer. What exists now is the boundary as an enforced contract: `src/nervo` as the core,
a `HostContract` two hosts already satisfy, and the lint that keeps the seam from rotting.
Migrating the live call-sites (the server's proposal/apply routes, the web store's actions)
onto the Nervo core is the next phase; the guard is already in place so that migration
happens under enforcement.

When a second real host does arrive, PowderMonkey consumes Nervo + Immersion as the first
host, and they ship with the minimal example host (`examples/word-host.ts`) and this doc so
others can build their own.
