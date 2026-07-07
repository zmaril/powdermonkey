# Spike: Claude usage/limits data source

> Phase 983 of "Global status bar". Goal: find a source for the operator's Claude
> usage/limits — how much of the rolling 5-hour window and the weekly window is spent
> — so the status bar can show, at a glance, whether there's headroom to dispatch more
> agents. This records what's available, what we picked, and the exact shape we build
> on.

## TL;DR

- **There is a first-party source and it's the same one Claude Code's own `/usage`
  command reads**: an OAuth-scoped Anthropic endpoint,
  `GET https://api.anthropic.com/api/oauth/usage`, authenticated with the OAuth
  **access token Claude Code already stored at login** — not an API key.
- The supervisor runs on the operator's machine under their Claude Code login, so the
  token is right there: `~/.claude/.credentials.json` (`claudeAiOauth.accessToken`) on
  Linux, or the **macOS Keychain** item `Claude Code-credentials` on a Mac. No new
  auth, no API key to provision, no scraping a TUI.
- The response gives exactly what a status bar wants: a **`limits` array** of windows,
  each with `kind` / `group` / `percent` used / `severity` / `resets_at` /
  `is_active`. The rolling window is `kind: "session"`, the weekly cap is
  `kind: "weekly_all"`, and per-model weekly caps come as `kind: "weekly_scoped"` with
  a `scope.model.display_name` (e.g. Opus).
- **Decision: use this endpoint, read the token from the local Claude Code login,
  degrade cleanly to `available: false` when there's no login / the token expired /
  the API is down.** Built as `src/server/claude-usage.ts` + `GET /claude/usage`, with
  a `PM_CLAUDE_USAGE_FIXTURE` seam for demoing the bar without a live login.

## Options considered

| Source | What it gives | Fit |
|---|---|---|
| **OAuth usage endpoint** (`/api/oauth/usage`) | The exact rate-limit windows, percent-used + reset time, per model | **Chosen.** First-party, no new auth, already how `/usage` works. |
| Response rate-limit **headers** (`anthropic-ratelimit-unified-*`) | The current window's status/remaining, but only on a *response we make* | The supervisor makes no Anthropic calls of its own, so there's nothing to read headers off. |
| **Admin/usage-report API** (`/v1/organizations/usage_report`) | Token/cost accounting for an org | Needs an **admin API key**, reports spend not *plan limits*, wrong grain for a solo operator on a subscription. |
| Scrape `claude`'s interactive `/usage` | The numbers, rendered | `/usage` is interactive-only (no `claude usage` subcommand); scraping a TUI is brittle. Rejected. |

## The endpoint

```
GET https://api.anthropic.com/api/oauth/usage
Authorization: Bearer <oauth access token>
anthropic-beta: oauth-2025-04-20
```

Real response (trimmed to the fields we build on):

```jsonc
{
  "five_hour": { "utilization": 11.0, "resets_at": "2026-07-03T02:40:00Z", ... },
  "seven_day": { "utilization": 12.0, "resets_at": "2026-07-05T18:00:00Z", ... },
  "limits": [
    { "kind": "session",       "group": "session", "percent": 11, "severity": "normal", "resets_at": "…", "is_active": false },
    { "kind": "weekly_all",    "group": "weekly",  "percent": 12, "severity": "normal", "resets_at": "…", "is_active": true },
    { "kind": "weekly_scoped", "group": "weekly",  "percent": 4,  "severity": "normal", "resets_at": "…",
      "scope": { "model": { "display_name": "Opus" } }, "is_active": false }
  ],
  "spend": { "used": { "amount_minor": 0, "currency": "USD" }, "enabled": false, ... },
  "extra_usage": { "is_enabled": false, ... }
}
```

We read the **`limits` array** (the top-level `five_hour`/`seven_day` are the same
numbers in an older shape). Each entry normalizes to a `UsageWindow`:
`{ key: kind, label, percent, severity, resetsAt }`. Labels: `session → "Session"`,
`weekly_all → "Weekly"`, `weekly_scoped → "Weekly · <model>"`.

## Where the token lives

The supervisor is local, on the operator's machine, running under their Claude Code
login — so `readOauthToken()` looks, in order of directness:

1. `CLAUDE_CODE_OAUTH_TOKEN` env (explicit override / CI).
2. `~/.claude/.credentials.json` → `claudeAiOauth.accessToken` (Linux, and older macOS).
3. macOS Keychain: `security find-generic-password -s "Claude Code-credentials" -w`
   → the same JSON blob.

We **only read** a token — never refresh it. Refreshing is Claude Code's job; an
expired token just surfaces as `available: false, reason: "Claude login expired"`.

## What shipped (this phase)

- `src/server/claude-usage.ts` — `getClaudeUsage()`: token discovery, the fetch (5s
  timeout), normalization to `UsageWindow[]`, a 60s cache that's served **stale on
  error** so a blip never blanks the bar, and the `PM_CLAUDE_USAGE_FIXTURE` seam
  (point it at a JSON dump of the raw response to demo/screenshot without a login).
- `GET /claude/usage` (`app.ts`) — returns `ClaudeUsage`
  (`{ available, windows, fetchedAt, reason? }`). Never errors; `available: false`
  carries the reason so the bar can say *why* it's dark.
- `src/web/app/useClaudeUsage.ts` — the client hook the status bar polls (phase 985
  renders it).

## Caveats

- **OAuth-only, subscription-scoped.** This reflects the operator's Claude *plan*
  limits (Pro/Max), which is exactly the audience — a solo operator dispatching
  `claude --remote` runs. It is not an org spend report and needs no admin key.
- **Unversioned/undocumented.** `/api/oauth/usage` is an internal endpoint behind an
  `anthropic-beta` header; the field set can shift. Normalization is defensive (reads
  `limits` if present, tolerates missing fields) and the whole path degrades to
  `available: false` rather than throwing — consistent with the project's
  "short shelf life, useful over elegant" ethos.
