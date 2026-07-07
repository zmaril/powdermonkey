// Claude usage/limits — the data behind the global status bar's "how much Claude
// have I got left" readout. The supervisor runs on the operator's own machine under
// their Claude Code login, so we read the *same* numbers Claude Code's own `/usage`
// command shows: the Anthropic OAuth usage endpoint, authenticated with the OAuth
// access token Claude Code already stored at login. See docs/claude-usage-spike.md
// for how this was found and the full raw response shape.
//
// This is deliberately best-effort and degrades cleanly: no token, an expired token,
// or an unreachable API all resolve to `{ available: false, reason }` rather than
// throwing, because a missing usage readout must never take the status bar (or the
// server) down. The last good result is cached and served stale on a later failure.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

// The endpoint Claude Code's `/usage` reads. Returns the subscription's rate-limit
// windows — the rolling 5-hour "session" window and the 7-day "weekly" windows — as
// percent-used + reset time. The OAuth beta header is required (it's an OAuth-scoped
// endpoint, not a normal API-key one).
const USAGE_URL = process.env.PM_CLAUDE_USAGE_URL ?? "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA = "oauth-2025-04-20";
const FETCH_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 60_000;

/** One rate-limit window, normalized for the UI: percent used (0–100), how severe
 *  that is, and when it rolls over. `key` is the raw limit kind (stable, for logic);
 *  `label` is the human name for the bar. */
export type UsageWindow = {
  key: string;
  label: string;
  percent: number;
  severity: string;
  resetsAt: string | null;
};

/** What `GET /claude/usage` returns. `available: false` carries a `reason` so the bar
 *  can show *why* it's dark (no login vs. API down) instead of a bare blank. */
export type ClaudeUsage = {
  available: boolean;
  windows: UsageWindow[];
  fetchedAt: string;
  reason?: string;
};

// ── The raw endpoint shape (only the fields we read; the response carries more) ──
type RawLimit = {
  kind: string;
  group: string;
  percent: number;
  severity: string;
  resets_at: string | null;
  scope: { model?: { display_name?: string | null } | null } | null;
  is_active: boolean;
};
type RawUsage = { limits?: RawLimit[] };

/** The OAuth access token Claude Code stored at login, or null if we can't find one.
 *  Checked in order of directness: an explicit env override, then the credentials
 *  file Claude Code writes on Linux, then the macOS Keychain entry it uses instead.
 *  We only ever read a token — never refresh it; that's Claude Code's job, and an
 *  expired token simply surfaces as `available: false`. */
function readOauthToken(): string | null {
  const fromEnv = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (fromEnv) return fromEnv;

  // Linux (and older macOS): a JSON credentials file under ~/.claude.
  try {
    const raw = readFileSync(join(homedir(), ".claude", ".credentials.json"), "utf8");
    const token = JSON.parse(raw)?.claudeAiOauth?.accessToken;
    if (typeof token === "string" && token) return token;
  } catch {
    // no file / unreadable / malformed — fall through to the keychain
  }

  // macOS: Claude Code keeps the credentials blob in the login Keychain.
  if (platform() === "darwin") {
    try {
      const out = execFileSync(
        "security",
        ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
      const token = JSON.parse(out)?.claudeAiOauth?.accessToken;
      if (typeof token === "string" && token) return token;
    } catch {
      // security(1) missing or no matching item
    }
  }

  return null;
}

/** Human label for a raw limit kind. Weekly-scoped windows name their model (e.g.
 *  "Weekly · Opus") so per-model caps are distinguishable in the bar. */
function labelFor(l: RawLimit): string {
  if (l.kind === "session") return "Session";
  if (l.kind === "weekly_all") return "Weekly";
  if (l.kind === "weekly_scoped") {
    const model = l.scope?.model?.display_name;
    return model ? `Weekly · ${model}` : "Weekly · scoped";
  }
  return l.kind;
}

/** Collapse the raw endpoint payload to the windows the bar renders. */
function normalize(raw: RawUsage): UsageWindow[] {
  return (raw.limits ?? []).map((l) => ({
    key: l.kind,
    label: labelFor(l),
    percent: Math.round(l.percent),
    severity: l.severity,
    resetsAt: l.resets_at,
  }));
}

// A file of the raw endpoint JSON, served instead of calling the API — so the bar can
// be developed/screenshotted without a live Claude login (mirrors PM_PR_FIXTURE_DIR).
function fixtureUsage(): ClaudeUsage | null {
  const path = process.env.PM_CLAUDE_USAGE_FIXTURE;
  if (!path) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as RawUsage;
    return { available: true, windows: normalize(raw), fetchedAt: new Date().toISOString() };
  } catch (e) {
    return {
      available: false,
      windows: [],
      fetchedAt: new Date().toISOString(),
      reason: `fixture unreadable: ${(e as Error).message}`,
    };
  }
}

let cache: { at: number; value: ClaudeUsage } | null = null;

/** Fetch (or serve from cache) the operator's Claude usage/limits. Never throws:
 *  every failure path returns `available: false` with a reason, and a prior good
 *  result is served stale when a refresh fails so a transient blip doesn't blank the
 *  bar. Cached for CACHE_TTL_MS so a fast poll from the UI doesn't hammer the API. */
export async function getClaudeUsage(): Promise<ClaudeUsage> {
  const fixture = fixtureUsage();
  if (fixture) return fixture;

  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.value;

  const token = readOauthToken();
  if (!token) {
    const value: ClaudeUsage = {
      available: false,
      windows: [],
      fetchedAt: new Date().toISOString(),
      reason: "no Claude login found",
    };
    cache = { at: now, value };
    return value;
  }

  try {
    const res = await fetch(USAGE_URL, {
      headers: { authorization: `Bearer ${token}`, "anthropic-beta": OAUTH_BETA },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      // 401 → token expired/invalid; anything else → API-side. Serve the last good
      // reading if we have one, so a hiccup doesn't blank a bar that was working.
      if (cache) return cache.value;
      const value: ClaudeUsage = {
        available: false,
        windows: [],
        fetchedAt: new Date().toISOString(),
        reason: res.status === 401 ? "Claude login expired" : `usage API ${res.status}`,
      };
      cache = { at: now, value };
      return value;
    }
    const raw = (await res.json()) as RawUsage;
    const value: ClaudeUsage = {
      available: true,
      windows: normalize(raw),
      fetchedAt: new Date().toISOString(),
    };
    cache = { at: now, value };
    return value;
  } catch (e) {
    if (cache) return cache.value;
    return {
      available: false,
      windows: [],
      fetchedAt: new Date().toISOString(),
      reason: `usage API unreachable: ${(e as Error).message}`,
    };
  }
}
