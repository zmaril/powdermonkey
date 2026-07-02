# Supervisor co-pilot

The supervisor stops being a chat you consult and becomes the thing that drives the
screen — present from the first window, able to do (on your word) or propose (on its own)
anything you could do by hand. This is the design behind task `t900`; `vocabulary.md`
defines the nouns (Repo, Window, Goal…) this builds on.

## What it is

One supervisor process, global awareness (see `vocabulary.md` Decision 6). The co-pilot is
its **face**: a pane that is

- **co-present from launch** — up alongside the `Ctrl+N` Blender repo picker, so setting up
  is a conversation, not a form;
- **able to act on the whole surface** — an equivalent of "full control of everything on
  screen," expressed as a bounded action API, not literal pixel-driving;
- **able to both do and propose** — you dictate ("show me the stuck sessions") and it acts;
  it also watches state and *suggests* ("3 sessions have run four days — open a triage
  window?"), which you accept or wave off.

## Two modes

- **Dictate** — you say what you want, it acts. Natural language → actions. "Open a window
  with repos A, B, C." "Add the linter goal to those three repos." "Dispatch the unblocked
  ones."
- **Propose** — it acts *on you*: watches the plan + runtime and surfaces suggestions as
  **highlights** you accept. The proactive half — the design-worthy half — because "an agent
  that rearranges your durable state unprompted" needs a firm approval boundary.

## The action surface

The co-pilot never touches pixels; it drives the app's **intent API** — the same actions the
UI buttons already call. Actions split by blast radius, and **the approval boundary follows
the blast radius, not the mode**:

| Class | Examples | Reversible? | Dictate | Propose |
|-------|----------|-------------|---------|---------|
| **View** | open/close/arrange panes, create/switch/close windows, put repos in a window, set filters, reveal an entity, scroll-to | yes, per-device, instant | **executes directly** | applies directly (a gentle, undoable nudge) |
| **Plan** | create/edit/archive goal·milestone·task·phase·repo, task fan-out, register/fork a repo | durable, shared | → **Proposal** | → **Proposal** |
| **Runtime** | dispatch, start-local, land, stop | costs money / spawns agents | → **Proposal** | → **Proposal** |

The rule in one line: **view actions execute; plan and runtime actions become proposals you
approve.** You are never surprised by a durable change or a dollar spent; you *are* helped by
the view rearranging itself to what you asked for.

## The action model: one typed catalog, two clients

The load-bearing decision behind all of the above — and the thing that keeps it from
degenerating into a pile of ad-hoc handlers — is that **an action is data, not a function
call.** Every action is a variant in one discriminated union with a schema; the human clicking
a button and the co-pilot deciding both emit the *same* value.

```ts
type Action =
  | { type: "window.open";   repoIds: number[] }                       // view
  | { type: "pane.arrange";  layout: DockLayout }                      // view
  | { type: "task.create";   milestoneId: number; title: string; repoIds: number[] }  // plan
  | { type: "depends.link";  taskId: number; dependsOn: number }       // plan
  | { type: "task.dispatch"; taskId: number }                          // runtime
```

Each variant registers exactly one spec — this is the whole "typed and understandable"
contract, and every behavior specced elsewhere in this doc derives from a field of it:

```ts
interface ActionSpec<A> {
  schema: TSchema                     // TypeBox — validates the params AND is the agent's tool definition
  klass: "view" | "plan" | "runtime"  // blast radius → approval boundary + undo behavior
  guard?(state): boolean              // legal in the current state? (the FSM hook — see below)
  apply(state, a): Patch              // how it mutates
  invert(state, a): Action            // the inverse command → undo history
  cost?(a): Cost                      // surfaced before a dispatch, or an undo-of-launch
}
```

Adding an action is adding a variant plus a spec; the type system becomes the map of the
entire surface. Nothing is "the agent version" of anything.

### Why one catalog, two clients (the LSP shape)

This is the **Language Server Protocol** pattern. LSP lets one language server feed any editor
(VS Code, Neovim, JetBrains) through a single typed message protocol — the server never knows
which editor is driving. The win is **M + N, not M × N**: define the protocol once, each client
speaks it once, instead of a bespoke integration per pair.

The co-pilot is the same shape: a typed action protocol that a **human-driven UI** and a
**machine-driven agent** both speak as peer clients.

| LSP | Co-pilot |
|-----|----------|
| Typed request catalog, JSON-schema'd | Typed action catalog, TypeBox-schema'd |
| Editor *and* automation send the same requests | Human clicks *and* agent both emit the same commands |
| Server advertises capabilities | FSMs advertise which actions are legal now |
| Requests are data — inspectable, loggable, replayable | Actions are commands — undoable, proposable, logged |

So the agent is never a bolted-on second system with its own API next to every UI button — the
agent and your mouse are two clients of one catalog. That's the anti-slop guarantee.

### Where the state machine earns its place

Model an FSM only for things with a real **lifecycle** — that's what makes `guard` principled
instead of scattered `if`s:

```
Session:  pending → running → (needs-input ⇄ running) → landed | stopped
Task:     pending → dispatched → in-progress → done        (advanced by reconcile off main)
Proposal: open → accepted | rejected
```

Then the **legal action set is a function of state**, computed once and consumed by three
clients from the same source of truth: the UI grays out illegal actions, the agent is only
offered legal tools (it *cannot* emit "land a session that isn't running"), and the API rejects
illegal transitions defensively.

**Do not machine the view layer.** "Which panes are open" has no lifecycle; forcing it into
states is the state-explosion slop we're avoiding. View actions are plain, always-legal
commands whose `invert` restores the prior view state. Underneath both sits one **command bus +
append-only log** — a transition function plus history, which is what gives undo, replay, and
proposals-as-parked-commands for free.

Prior art to borrow (not adopt wholesale): **statecharts / XState** for the entity FSMs (or a
hand-rolled transition table — the dep may be overkill), **CQRS / event-sourcing** for the
command log, and **LSP** for the one-protocol-two-clients shape.

## Undo: full history, every action

Every action — yours or the co-pilot's, view / plan / runtime alike — lands on a **single
undo/redo history**, walked back in order. Each action carries its inverse:

- **View** — restore the prior view state. Silent, instant.
- **Plan** — apply the inverse edit (un-archive, restore prior field values, delete a
  just-created entity). PM's soft-delete/restore already makes most of these clean.
- **Runtime** — *not* silently reversible: undoing a **launch** means **stopping the task**.
  So undo of a dispatch/start asks first — "Undo this dispatch? It will stop `t892`'s session"
  — rather than quietly killing running work.

The rule mirrors the forward boundary: the **cost surfaces before the inverse runs**. Undoing
a window rearrange is free; undoing a launch is a decision, so it's confirmed — and a redo of
that launch re-dispatches.

## Present from the first window

On launch (and on every `Ctrl+N`), the supervisor pane comes up beside the repo picker. It
can read what you have (`gh repo list`) and narrate the setup: "You've got 12 repos; 3 have
open linter work — want a window scoped to those?" Onboarding becomes dictation, and an empty
first-run is the supervisor offering to build you a starting window instead of a blank slate.

## Scope: one co-pilot per window

The co-pilot is **per-window** — each window has its own, scoped to that window's repos. It
drives *its* window and nothing off-screen; opening another window spins up another co-pilot
(a new agent, counted against the cap the status bar shows). What stays global is
**awareness, not a pane**: one backend supervisor keeps the whole-system view — every repo,
every running session, the concurrency/budget cap — and surfaces it in the global status bar.
So global awareness lives in the bar, local action in each window's co-pilot. (This resolves
the open supervisor-scope question in `vocabulary.md`.)

## Proposals: reuse, don't reinvent

PowderMonkey already has a **proposals** mechanism — structured change-sets over the *plan*
that you accept/reject. The co-pilot's propose layer is that mechanism widened:

- today a proposal carries **plan** edits;
- extend its payload to also carry **runtime** actions (dispatch, land) — same accept/reject
  UX, now able to say "dispatch these four" as one reviewable unit;
- **view** actions stay *out* of proposals — they're reversible and per-device, so they just
  execute (with a one-click undo), never a modal.

So most of this is "point the existing proposals flow at a wider set of actions," not a new
subsystem — which is why `t900`'s build phases (action bus, dictation) can precede the doc's
harder question: how proactive proposals are surfaced without being noise.

## The dispatchable frontier (why tasks need dependencies)

The headline proactive suggestion is **"what can we kick off right now?"** — the
dependency-safe frontier. Computing it needs something the schema lacks today: a **task
dependency edge**. `t893` depends on `t892`; `t899` depends on nothing. Without that edge, a
human eyeballs it (as happened this session); with a lightweight `depends_on` (task → task),
the supervisor computes the frontier and highlights the ready tasks — unblocked, no in-flight
schema collision, not already running.

This is the smallest data addition that turns "I wish you could highlight what's ready" into
something PM does itself.

## Seeing the screen

To act well the co-pilot needs to read current **view state** (which windows are open, active
panes, filters) on top of the plan state it already has from the DB. View state is
frontend/per-device, so there's a small bidirectional channel: the client publishes its view
state, the supervisor emits actions back over the same sync path the UI already uses. No
screen-scraping — structured state in, structured actions out.

## Principles

- **Dictation executes; proaction proposes.** The operator is never surprised by a durable
  change or a spend — those are always accept-first.
- **View nudges are cheap and undoable.** Rearranging panes on request should feel instant and
  reversible, never a confirmation dialog.
- **Highlights over interrupts.** Proactive suggestions render as ambient highlights on the
  board (a "ready to dispatch" glow, a triage nudge), not modals that block work.
- **One supervisor, one budget.** Every action the co-pilot takes counts against the same
  concurrency/budget cap the global status bar tracks; proposing a five-way dispatch shows its
  cost before you accept.

## Decisions (and why)

1. **Intent API, not pixel control.** "Full control of the screen" is delivered as the typed
   action set the UI already exposes, so the co-pilot and a human click the same levers. No
   brittle DOM-driving, and every action is already permission-shaped.
2. **Approval boundary = blast radius (as the default).** View auto-executes; plan/runtime
   propose. Splitting on reversibility/cost (not on who initiated) is what makes an always-on
   driver safe. This is the *default* the settings in Decision 6 relax.
3. **Extend proposals, don't fork them.** Runtime actions ride the existing accept/reject flow;
   view actions skip it. Reuse keeps one review surface.
4. **`depends_on` on tasks, authored either way.** The frontier computation — the most useful
   proactive suggestion — is impossible without this edge. You hook edges up by hand, *or* the
   supervisor proposes them like any other plan element (through the same accept/reject flow),
   so dependency structure is human-owned and machine-assisted.
5. **One co-pilot per window; awareness stays global.** Each window's co-pilot is scoped to its
   repos and drives only its window; a new window means a new co-pilot. Whole-system awareness
   (repos, running sessions, budget) lives in the global status bar, not in any one pane.
6. **Proactivity and permissions are settings, tuned by feel.** Two dials, modeled on Claude
   Code's permission modes / auto-approve: a **proactivity** setting (how much the co-pilot
   surfaces unprompted — from silent, to ready-work-only, to everything actionable) and a
   **permission** setting (whether, and which, durable actions graduate from accept-first to
   auto-execute). The decision here is only *that these are dials, not fixed policy*; the right
   defaults and levels come out with experience — you have to see how it feels.
7. **One undo history for everything; irreversible inverses confirm.** Full undo/redo across
   view, plan, and runtime — every action carries an inverse. Where the inverse has real-world
   cost (undoing a launch = stopping a session), undo prompts instead of silently reverting, so
   you never lose running work to a reflexive Ctrl+Z.
8. **Actions are typed data, one catalog, two clients (the LSP shape).** Every action is a
   schema'd command in a single discriminated union; the human-driven UI and the machine-driven
   agent are peer clients of that catalog, never separate APIs. FSMs (for lifecycled entities
   only) make the legal action set a function of state. This is the anti-slop guarantee the rest
   of the design leans on — see "The action model."

## Prior art

- **PowderMonkey's own proposals** — the plan-edit accept/reject flow this generalizes.
- **Copilot Workspace / agent "plans"** — agents that propose a sequence of edits for approval;
  we apply the same to on-screen and runtime actions.
- **Blender's operators + Firefox session** — a bounded, discoverable action set over a view
  that restores itself; the co-pilot is those operators, driven by language.

## Open questions

These are the "tune by experience" residuals — the shape is decided (above); the values aren't.

- **Proactivity defaults & levels.** Given it's a dial (Decision 6), what are the named levels
  and where does the default sit? Comes out with use.
- **Permission graduation — feel.** Which durable action classes are even *eligible* to
  graduate to auto-execute, and does dispatch/spend ever qualify? Settle by living with it.
- **Auto-proposed dependency edges.** Beyond hand-authoring, what heuristics let the supervisor
  *propose* `depends_on` edges (e.g. "these four touch the repos migration `t892` owns")
  without over-proposing?
- **Durable-undo scope.** The history spans shared/durable actions, so undoing one can touch
  work another window or agent is mid-flight on. What fences a plain undo from clobbering
  concurrent work — a "yours/recent-only" boundary, or a warning when the inverse crosses into
  changes you didn't make?
