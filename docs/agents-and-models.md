# Agents & models

Today PowderMonkey is hardwired to one agent — `claude --remote` — in the dispatch path
(`PM_DISPATCH_CMD`). This is the design for making the agent **pluggable**: many agents, local
and cloud, many models, **configured and selectable, mixed and matched per task**. Builds on
`vocabulary.md` (Task, Repo, Session) and `supervisor-copilot.md` (actions as typed data).

## The model

A Task already targets a **Repo** (*where* it runs). It now also runs on a **Runtime** (*who*
runs it):

```
Task ─ targets ─→ Repo                       (where — existing)
     └ runs on  ─→ Runtime                    (who — new)

Runtime = Agent  ×  Location  ×  Model
          claude    local        (backend-specific model id)
          codex     cloud
          pi
```

- **Agent** — the coding tool: `claude`, `codex` (OpenAI Codex CLI), `pi` (Pi.dev). Extensible.
- **Location** — `local` (a worktree/checkout on this machine, using your installed tool + git
  auth) or `cloud` (an isolated sandbox the provider runs, opening a PR via its GitHub App).
- **Model** — the specific model the agent runs, enumerable per agent.

A Task **inherits a default Runtime** from its repo → milestone → goal (same cascade as the
repo default), pre-filled and freely overridden. That's the "mix and match many models" —
per-task selection, rarely typed by hand.

## The invariant that makes this tractable

**Progress is read off `main` from `PM-Phase:` / `PM-Task:` trailers, never self-reported.**
PowderMonkey does not care which agent wrote the commits — any Runtime that lands trailered
commits on `main` just works. So agents plug in *underneath* the tracking model without
touching it. This is the whole reason multi-agent is a configuration problem, not a rewrite.

## Runtimes are typed config, not code paths

Adding an agent must not mean forking `dispatch.ts`. A Runtime is a **registry entry** with a
typed spec — the same anti-slop stance as the action catalog in `supervisor-copilot.md`:

```ts
interface Agent {
  id: "claude" | "codex" | "pi"          // extensible
  locations: ("local" | "cloud")[]        // which it supports
  models(): ModelId[]                      // static list or queried from the tool
  command(ctx): string                     // invocation template: {prompt_file} {cwd} {model}
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

`PM_DISPATCH_CMD` / `PM_SESSION_CMD` become the *default* templates for the `claude` entry;
every other agent is another entry. One registry; add an agent = add a row.

## The targets

| Runtime | Loc | Isolation | PR / push auth | Needs installed |
|---------|-----|-----------|----------------|-----------------|
| `claude` cloud | cloud | fresh sandbox | Claude GitHub App | — (have) |
| `claude` local | local | your worktree | your git/gh | `claude` (have) |
| `codex` cloud | cloud | fresh sandbox | provider GitHub App (TBD) | — |
| `codex` local | local | your worktree | your git/gh | `codex` |
| `pi` local | local | your worktree | your git/gh | Pi.dev, running local to the web server |

Pi.dev runs **local to the supervisor's web server** — a local agent against the repo's cache
clone, no cloud sandbox.

## Local vs cloud is the load-bearing axis

Agent and model vary within it, but **local vs cloud is where the real differences live**:

- **Cloud** (`claude --remote`, `codex` cloud): an isolated sandbox clones the repo, does the
  work, opens a PR via the *provider's* GitHub App — no local auth, no local install. Bounded
  by that provider's cloud concurrency/budget cap. Returns a `View:` URL captured on the session.
- **Local** (`claude`, `codex`, `pi` local): runs in a worktree cut from the repo's cache clone
  (see `vocabulary.md`), uses your local install and your git/PR auth, bounded by your machine.
  Faster iteration, no per-run cloud cost, you own the branch/PR.

## Selection & configuration

- **Agent registry** (Settings): which agents are available, their models, local binary paths /
  API keys, and whether cloud is enabled. This is where `codex`/`pi` get turned on.
- **Per-task Runtime picker** — agent + location + model, pre-filled from the inherited default.
  Dispatch resolves the task's Runtime; nothing is hand-typed in the common case.
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
- `sessions` gain `agent` + `model` (today's `kind: local | remote` becomes the `location` axis).
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
4. **Local vs cloud is the primary axis; model is a sub-selection.** Auth, isolation, cost, and
   speed all split on location — so the abstraction is built around it, with agent and model
   varying inside.

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
- **Model enumeration.** Static per-agent list, or queried from the tool at registration?
- **Fallback / routing.** Auto-retry on another backend when one fails or is at cap — worth it,
  or explicit-only? (Likely later.)
