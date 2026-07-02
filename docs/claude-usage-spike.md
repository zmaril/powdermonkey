# Spike: Claude usage/limits data source

The global status bar (see `docs/vocabulary.md` → "Global status bar") wants to surface
**Claude usage / limits** — "remaining budget and rate/concurrency headroom, *as the
data is available*." This spike establishes where that data actually comes from and how
PowderMonkey reads it. The result is `src/server/claude-usage.ts` + `GET /claude-usage`.

## The landscape

PowderMonkey has no Anthropic account of its own — it supervises the operator, who is
signed into Claude Code. So the only usage data available is the operator's, and the
question is how to read *their* session without disturbing it. Three candidate sources:

| Source | Gives us | Verdict |
| --- | --- | --- |
| `~/.claude/.credentials.json` (`claudeAiOauth`) | `subscriptionType` (e.g. `max`), `rateLimitTier` (e.g. `default_claude_max_20x`), the OAuth `accessToken` + `expiresAt` | **Used** — static tier metadata, almost always readable, even offline. |
| `GET /api/oauth/usage` (bearer = that access token) | Live per-window utilization (5-hour, 7-day, per-model), each `{ utilization, resets_at }` | **Used** — this is what Claude Code's own `/usage` reads. Needs a *valid* token. |
| API rate-limit response headers (`anthropic-ratelimit-unified-*`) | Live utilization, but only on an inference response | **Not used** — PM issues no inference, so there's no response to read them off. |

Two sources rejected outright:

- **Refreshing the OAuth token ourselves.** The token expires and Claude Code refreshes
  it on its own schedule. If PM refreshed it (using the `refreshToken`), it would race
  the interactive CLI / daemon that owns the session and could invalidate the operator's
  live login. So PM is strictly **read-only**: it uses the token as-is and, when it's
  expired, degrades rather than refreshing. This is the key design constraint.
- **An `ANTHROPIC_API_KEY` path.** Would report the *API* account's usage, not the
  Claude Code subscription the operator actually runs agents against. Different pool.

## What's on the wire

The endpoint is `GET https://api.anthropic.com/api/oauth/usage`, with:

```
Authorization: Bearer <claudeAiOauth.accessToken>
anthropic-beta: oauth-2025-04-20
```

Its body is keyed by rate-limit window — `five_hour`, `seven_day` (and per-model scope
entries) — each shaped roughly `{ utilization, resets_at, scope: { model: { display_name } } }`,
where `utilization` is a percent/fraction and `resets_at` is an epoch timestamp. This
shape was reconstructed from the Claude Code binary (the same code that renders `/usage`),
**not** from a stable public contract — so `parseUsageWindows` reads it defensively:
it picks out any window-shaped entry and skips the rest, and `normalizeUtilization` /
`normalizeResetsAt` tolerate both percent-and-fraction and seconds-and-ISO forms.

## The `available` flag (why the type has one)

Because the token expires and we won't refresh it, the live read fails routinely. So
`ClaudeUsage.available` is a first-class part of the contract:

- `available: true` — the endpoint answered; `windows` is real.
- `available: false` — degraded. `windows` is empty and `reason` says why (token
  expired, no credentials, endpoint unreachable). The tier metadata is still returned
  when the credentials file exists, so the bar can show the plan even when it can't show
  the live numbers.

**Observed on the dev machine during this spike:** the stored access token was expired
(the daemon reported `auth_required`), so the live endpoint 401s and PM returns
`available: false` with the `max` / `default_claude_max_20x` tier. That degraded state is
the common case, and exercising it is exactly why the flag exists — the bar must read
well when usage is unknown, which is most of the time PM runs unattended.

## Config knobs

- `PM_CLAUDE_CREDENTIALS` — path to the credentials JSON (default `~/.claude/.credentials.json`).
- `PM_CLAUDE_USAGE_URL` — the usage endpoint (default the real API); pointing it at a
  local fixture server is how the live path is tested without a real token.

## Follow-ups (out of scope for this task)

- **Concurrency headroom** — the vocabulary also wants "rate/concurrency headroom"
  (N agents against your cap). That's a *count vs. tier limit* ratio, which needs the
  numeric cap for each `rateLimitTier`; the usage endpoint doesn't hand that over
  directly. Left for a follow-up once the running-agents count (this task) is in place.
- **A refresh strategy** — if the expired-token degradation proves too common to be
  useful, a future option is to *observe* (never drive) the CLI's own refreshes, or read
  a fresher token the daemon may cache. Not attempted here to keep PM read-only.
