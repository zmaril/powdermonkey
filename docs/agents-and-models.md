# Agents & models

Today PowderMonkey is hardwired to one agent — `claude --remote` — in the dispatch path
(`PM_DISPATCH_CMD`). This is the design for making the agent **pluggable**: many agents, running
local / host / cloud, many models, **configured and selectable, mixed and matched per task**. Builds on
`vocabulary.md` (Task, Repo, Session) and `supervisor-copilot.md` (actions as typed data).

## The model

A Task already targets a **Repo** (*where* it runs). It now also runs on a **Runtime** (*who*
runs it):

```
Task ─ targets ─→ Repo                       (where — existing)
     └ runs on  ─→ Runtime                    (who — new)

Runtime = Agent  ×  Location  ×  ModelChoice
          claude    local        └ Model  ×  Version  ×  Effort
          codex     host           opus       4.8         high
          pi        cloud          sonnet     5           medium
```

- **Agent** — the coding tool: `claude`, `codex` (OpenAI Codex CLI), `pi` (Pi.dev). Extensible.
- **Location** — where the agent actually runs: `local` (your laptop — the client machine, your
  install + your git auth), `host` (the supervisor's own machine — its install, its worktrees,
  its auth), or `cloud` (an isolated sandbox the provider runs, opening a PR via its GitHub App).
  See *Local, host, cloud* below — `local` and `host` are the same box when you self-host.
- **ModelChoice** — not one flat id but three nested picks: **Model** (the family — `opus`,
  `sonnet`, `gpt-5-codex`), **Version** (the dated release under it — `opus 4.8`, `sonnet 5`),
  and **Reasoning effort** (`low | medium | high | xhigh | max`, where the agent/model exposes
  it). Each is enumerated per agent; the last two default sensibly so the common case is one pick.

A Task **inherits a default Runtime** from its repo → milestone → goal (same cascade as the
repo default), pre-filled and freely overridden. That's the "mix and match many models" —
per-task selection, rarely typed by hand.

## Model, version, and reasoning effort

"Model" is really three nested dimensions, and collapsing them into one string is the mistake
to avoid — it's what makes a picker unusable and a default un-inheritable:

- **Model** — the family: `opus`, `sonnet`, `haiku` for `claude`; `gpt-5-codex` for `codex`.
  This is the choice you actually reason about ("cheap and fast" vs "deep").
- **Version** — the dated release pinning that family: `opus 4.8`, `sonnet 5`, `haiku 4.5`.
  Defaults to the agent's current release for the family, but pinnable so a task is reproducible
  and a version bump can't silently change a running plan's behavior.
- **Reasoning effort** — `low | medium | high | xhigh | max`, the thinking-budget knob, **only
  where the agent/model exposes it**. Not every backend has it (a fixed-effort model has none),
  so it is a *capability*, not a required field — the picker shows the effort control only when
  the selected model advertises efforts, and hides it otherwise.

The three cascade: pick a Model, its Versions narrow, its Efforts narrow again. A `ModelChoice`
is therefore `{ model, version?, effort? }` — the two optionals resolve to the agent's default
release and default effort at dispatch, so `{ model: "opus" }` is a complete, valid choice.

## The invariant that makes this tractable

**Progress is read off `main` from `PM-Phase:` / `PM-Task:` trailers, never self-reported.**
PowderMonkey does not care which agent wrote the commits — any Runtime that lands trailered
commits on `main` just works. So agents plug in *underneath* the tracking model without
touching it. This is the whole reason multi-agent is a configuration problem, not a rewrite.

## Runtimes are typed config, not code paths

Adding an agent must not mean forking `dispatch.ts`. A Runtime is a **registry entry** with a
typed spec — the same anti-slop stance as the action catalog in `supervisor-copilot.md`:

```ts
type Effort = "low" | "medium" | "high" | "xhigh" | "max"

interface ModelDef {
  id: string                               // family: "opus" | "sonnet" | "gpt-5-codex"
  versions: string[]                       // dated releases, newest first: ["4.8", "4.7"]
  defaultVersion: string                   // pre-filled version for this family
  efforts?: Effort[]                       // present only if the model exposes effort
  defaultEffort?: Effort                   // pre-filled effort, when efforts is present
}

interface ModelChoice { model: string; version?: string; effort?: Effort }

interface Agent {
  id: "claude" | "codex" | "pi"          // extensible
  locations: ("local" | "host" | "cloud")[] // which it supports (local = laptop runner, TBD)
  models(): ModelDef[]                     // families + versions + efforts; static or queried
  command(ctx): string                     // template: {prompt_file} {cwd} {model} {version} {effort}
  tty: boolean                             // needs a PTY? (claude --remote does)
  caps: {
    opensPr: boolean                       // cloud agents open their own PR
    needsGithubApp: boolean                // cloud push auth via the provider's GitHub App
    worktree: boolean                      // local agents run in a git worktree / cache clone
    isolatedCloud: boolean                 // fresh sandbox per run
  }
  capture(output): { sessionUrl?: string; branch?: string }  // read back the run's handle
}
```

`models()` returns families, not flat ids, so a picker can cascade Model → Version → Effort and
a default can be inherited at any of the three levels. `command(ctx)` interpolates the resolved
choice: `{model} {version}` map to the agent's model flag (`claude --model opus-4.8`,
`codex --model gpt-5-codex`) and `{effort}` to its effort flag where the model has one, dropped
otherwise.

`PM_DISPATCH_CMD` / `PM_SESSION_CMD` become the *default* templates for the `claude` entry;
every other agent is another entry. One registry; add an agent = add a row.

## The targets

| Runtime | Loc | Isolation | PR / push auth | Needs installed |
|---------|-----|-----------|----------------|-----------------|
| `claude` cloud | cloud | fresh sandbox | Claude GitHub App | — (have) |
| `claude` host | host | supervisor worktree | supervisor git/gh | `claude` on the host (have) |
| `codex` cloud | cloud | fresh sandbox | provider GitHub App (TBD) | — |
| `codex` host | host | supervisor worktree | supervisor git/gh | `codex` on the host |
| `pi` host | host | supervisor worktree | supervisor git/gh | Pi.dev on the host |
| `*` local | local | laptop worktree | your laptop git/gh | agent on your laptop **+ a runner (TBD)** |

Every non-cloud agent here runs on the **host** — the supervisor's machine, against the repo's
cache clone, using the host's install and auth. Pi.dev is host-only by nature (no cloud sandbox).
The `local` row is the one that isn't built yet: running the agent on **your laptop** while the
supervisor is remote needs a laptop-side runner (see *Local, host, cloud*).

## Local, host, cloud

Agent and model vary within it, but **where the agent runs is the load-bearing axis** — auth,
isolation, cost, and speed all split on it. Three values:

- **Cloud** (`claude --remote`, `codex` cloud): an isolated sandbox clones the repo, does the
  work, opens a PR via the *provider's* GitHub App — no local auth, no local install. Bounded
  by that provider's cloud concurrency/budget cap. Returns a `View:` URL captured on the session.
- **Host**: runs on the **supervisor's own machine**, in a worktree cut from the repo's cache
  clone (see `vocabulary.md`), using the host's install and the host's git/PR auth, bounded by
  that machine. This is exactly what the code calls a "local" session today — it lives next to
  the supervisor (`worktree.ts`, `session-pty.ts`), because the supervisor is the only thing
  that spawns and owns the agent process.
- **Local**: runs on **your laptop** — the client machine you're viewing from — with *your*
  install and *your* git auth. Only meaningfully distinct from `host` when the supervisor is
  **remote**, and it isn't built yet: the supervisor spawns agents on its own tmux socket and
  filesystem, so putting one on the laptop needs a laptop-side **runner** that the supervisor
  dispatches to and relays the PTY from. That's the one genuinely new subsystem here.

### host and local are the same box when you self-host

`local` (laptop) and `host` (supervisor machine) are distinct *roles* that **coincide on one
machine when you run the supervisor on your laptop** — the today-default. So, pragmatically:

| Where the supervisor runs | Available locations | Why |
|---------------------------|---------------------|-----|
| **On your laptop** (default) | `local` + `cloud` | host *is* your laptop, so the on-machine run is just "local" — no runner needed |
| **On a remote server** | `host` + `cloud` | the on-machine run is the server (`host`); true `local` (laptop) awaits the runner |

In other words: today's "local" session is `host` in the general model, and it earns the name
`local` only when the host happens to be your laptop. Nothing new ships to get `host` + `cloud`
working remotely — that's the current code with the supervisor moved to a server. The laptop
runner is the only piece deferred, and it's what unlocks `local` while the server is elsewhere.

## Selection & configuration

- **Agent registry** (Settings): which agents are available, their models, local binary paths /
  API keys, and whether cloud is enabled. This is where `codex`/`pi` get turned on.
- **Per-task Runtime picker** — agent + location + **model → version → effort**, each pre-filled
  from the inherited default and cascading (choosing a model narrows its versions, then its
  efforts; the effort control appears only for models that expose one). Dispatch resolves the
  task's Runtime; the common case is one visible pick and three sensible defaults.
- **As an action** (`supervisor-copilot.md`): dispatch carries `{ taskId, runtime }`. The
  Runtime is a typed parameter of the `task.dispatch` command, so the co-pilot selects a
  backend the same way you do — one catalog, two clients.

## Budget & concurrency across backends

Multiple agents means multiple cost/limit sources. The global status bar
(`supervisor-copilot.md`) aggregates usage **across providers**, and concurrency caps are
**per-backend** (Claude's cloud cap, OpenAI's, and "your machine" for local). Five Claude-cloud
agents plus five Codex-cloud agents are two separate caps, not one — the bar has to show them
side by side. Normalizing cost across providers into one number is a spike, not a given.

## Where it meets the runtime (code)

- `dispatch` / `start-local` resolve the task's Runtime → choose the agent's command template,
  location, and cwd (the repo cache clone) → spawn (PTY when `tty`) → `capture()` the handle
  (cloud URL or local branch).
- `sessions` gain `agent` + `model` + `version` + `effort`, and today's `kind: local | remote`
  becomes a `location: local | host | cloud` axis (the old `remote` is `cloud`; the old `local`
  is `host`). The fully-resolved choice is recorded on the run, not just the family, so a session
  is reproducible and the status bar can group by exact model.
- **Reconciliation is unchanged** — trailers off `main`, agent-agnostic.

## Decisions (and why)

1. **Task → Runtime mirrors Task → Repo.** Per-task selection with a default cascaded from
   repo/milestone/goal. Same mechanism, so mixing models is authoring, not configuration
   spelunking.
2. **Agents are typed registry entries, not branches in the dispatcher.** Add an agent = add a
   row; `command`/`caps`/`capture` cover the differences. Same anti-slop stance as the action
   catalog.
3. **Progress stays agent-agnostic.** Trailers off `main` are the neutral contract every backend
   meets; it's what turns "support another agent" into a config change.
4. **Location is the primary axis (`local | host | cloud`); model is a sub-selection.** Auth,
   isolation, cost, and speed all split on location — so the abstraction is built around it, with
   agent and model varying inside. `local` and `host` are the same box when you self-host, so the
   default deployment sees `local + cloud` and a remote server sees `host + cloud`; the laptop
   runner that makes `local` distinct from `host` is deferred (see open questions).
5. **Model is three nested picks, not one string.** Model → version → effort cascade, with
   version and effort optional and defaulted. Keeps the picker one visible choice in the common
   case, lets a default cascade at any level, and pins a version so a plan is reproducible.
   Reasoning effort is a *capability* — surfaced only where the model has it, never a required
   field — so fixed-effort backends don't grow a dead control.

## Prior art

- **OpenAI Codex** calls a repo an *Environment* and runs a task in one — our Location × Repo.
- **aider `--model`, continue.dev config, LiteLLM / OpenRouter** — model selection and provider
  routing as configuration, which is the shape of the agent registry.

## Open questions

- **Auth & secrets storage.** Per-agent API keys and local binary paths — where they live and how
  they're secured (a local agent needs your keys; a cloud one needs the provider's GitHub App).
- **Non-Claude cloud PR mechanism.** Does `codex` cloud push via a GitHub App too, or a different
  path? Determines the `needsGithubApp`/`caps` shape for cloud agents beyond Claude.
- **Capability gating.** Should a task or repo be able to *require* a capability (cloud
  isolation, a specific model) so incompatible Runtimes are rejected before dispatch?
- **Cost normalization.** One budget number across providers, or per-provider meters only?
- **Model enumeration.** Static per-agent list, or queried from the tool at registration? And is
  the version list pinned in the registry or pulled live so new releases appear without a redeploy?
- **Effort normalization.** `low..max` is Claude's ladder; other agents expose different or no
  effort rungs. Do we map every backend onto one shared ladder (and how do the rungs line up), or
  keep effort agent-native and only show what each backend actually advertises?
- **Default granularity.** The inherited default is a `ModelChoice` — should repo/milestone/goal
  be able to fix just the model family and let version/effort float to the agent's current
  default, or must a default pin all three?
- **The laptop runner (`local` while the server is remote).** The one unbuilt location. What's
  the transport — the runner polls the supervisor for dispatch actions, or holds a socket the
  supervisor pushes to? Does its PTY tunnel *up* to the supervisor (which relays to the browser,
  keeping one client endpoint) or does the browser connect to the runner directly? And how does
  the laptop get the repo + your auth without the supervisor's cache clone?
- **Fallback / routing.** Auto-retry on another backend when one fails or is at cap — worth it,
  or explicit-only? (Likely later.)
