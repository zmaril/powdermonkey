import { homedir } from "node:os";
import { join } from "node:path";
import type { ClaudeUsage, UsageWindow } from "../shared/types.ts";

// The Claude usage/limits data source for the global status bar.
//
// There is no PowderMonkey-owned account here: the numbers we want ("how much of the
// 5-hour / weekly cap is left") belong to the operator's *own* Claude Code login. So
// this reads that login read-only and never writes to it:
//
//   1. `~/.claude/.credentials.json` → `claudeAiOauth` carries the plan tier
//      (`subscriptionType`, e.g. "max"), the rate-limit tier (`rateLimitTier`, e.g.
//      "default_claude_max_20x"), the OAuth `accessToken`, and its `expiresAt`. The
//      tier fields are static-ish and almost always readable — the bar can show the
//      plan even offline.
//   2. `GET /api/oauth/usage` (the endpoint behind Claude Code's own `/usage`) returns
//      the live per-window utilization, authed with that access token.
//
// The catch — and why the type carries an `available` flag — is that the stored token
// expires (Claude Code refreshes it on its own schedule), and refreshing it ourselves
// would race the interactive CLI/daemon that owns the OAuth session. So we deliberately
// do NOT refresh: when the token is expired (or absent, or the endpoint is down) we
// return the tier metadata with `available:false` and a `reason`, and the bar degrades
// to "usage unavailable". That's the vocabulary's "as the data is available" made real.
//
// See docs/claude-usage-spike.md for the full findings behind this module.

/** Where the operator's Claude Code OAuth credentials live. Overridable so tests can
 *  point at a fixture and a non-standard `$HOME` layout still works. */
const CREDENTIALS_PATH =
  process.env.PM_CLAUDE_CREDENTIALS ?? join(homedir(), ".claude", ".credentials.json");

/** The usage endpoint. Overridable so a test can stand up a local fixture server
 *  instead of reaching the real API. */
const USAGE_ENDPOINT =
  process.env.PM_CLAUDE_USAGE_URL ?? "https://api.anthropic.com/api/oauth/usage";

// The OAuth beta header Claude Code sends on this endpoint; without it the API 400s.
const OAUTH_BETA = "oauth-2025-04-20";

// The read is cheap but it hits the operator's disk and (when live) an external API,
// so cache the snapshot briefly — the bar polls, and several tabs share one server.
const CACHE_TTL_MS = 60_000;

// Give up on the network read quickly; a hung request must never stall the bar.
const FETCH_TIMEOUT_MS = 4_000;

type OauthCreds = {
  accessToken?: string;
  expiresAt?: number;
  subscriptionType?: string;
  rateLimitTier?: string;
};

/** Read + parse the `claudeAiOauth` block. Returns null (not throws) when the file is
 *  missing or unreadable — a machine that has never run Claude Code is a valid state. */
async function readCreds(): Promise<OauthCreds | null> {
  try {
    const raw = await Bun.file(CREDENTIALS_PATH).text();
    const parsed = JSON.parse(raw) as { claudeAiOauth?: OauthCreds };
    return parsed.claudeAiOauth ?? null;
  } catch {
    return null;
  }
}

/** Normalize a utilization figure to a 0..1 fraction. The endpoint reports some fields
 *  as a percent (0..100) and some as a fraction (0..1); anything over 1 is read as a
 *  percent. Clamped so a bad value can't blow past the meter. */
export function normalizeUtilization(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  const frac = n > 1 ? n / 100 : n;
  return Math.min(frac, 1);
}

/** Normalize a reset timestamp to epoch ms. The endpoint uses epoch seconds; ISO
 *  strings are tolerated too. Null when absent or unparseable. */
export function normalizeResetsAt(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    // < 1e12 is far too small to be epoch ms (that's year ~2001), so it's seconds.
    return raw < 1e12 ? Math.round(raw * 1000) : Math.round(raw);
  }
  if (typeof raw === "string") {
    const t = Date.parse(raw);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

// The window names the endpoint keys on, mapped to the short labels the bar shows.
const WINDOW_LABELS: Record<string, string> = {
  five_hour: "5h",
  seven_day: "7d",
  seven_day_oauth: "7d",
};

/** True when a value looks like a usage window (`{ utilization|percent, resets_at }`).
 *  Used to pick window entries out of the response without hard-coding every key. */
function looksLikeWindow(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return "utilization" in o || "percent" in o;
}

/** Turn a raw `/api/oauth/usage` body into the windows the bar renders. Defensive by
 *  design: the response shape isn't a stable public contract, so we read whatever
 *  window-shaped entries are present (`five_hour`, `seven_day`, and any per-model
 *  scope) and skip the rest rather than assume a fixed schema. Pure + exported so the
 *  parser is unit-tested without touching the network. */
export function parseUsageWindows(body: unknown): UsageWindow[] {
  if (typeof body !== "object" || body === null) return [];
  const windows: UsageWindow[] = [];
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (!looksLikeWindow(value)) continue;
    const util = normalizeUtilization(value.utilization ?? value.percent);
    if (util === null) continue;
    const scope = value.scope as { model?: { display_name?: string } } | undefined;
    const label = WINDOW_LABELS[key] ?? scope?.model?.display_name ?? key;
    windows.push({ label, utilization: util, resetsAt: normalizeResetsAt(value.resets_at) });
  }
  return windows;
}

/** Assemble the snapshot from the pieces — tier metadata (always, when creds exist),
 *  live windows when we got them, and the honest `available`/`reason` split. Pure +
 *  exported so the branching is testable without disk or network. */
export function buildUsage(
  creds: OauthCreds | null,
  windows: UsageWindow[] | null,
  reason: string | null,
  now: number,
): ClaudeUsage {
  return {
    available: windows !== null,
    subscriptionType: creds?.subscriptionType ?? null,
    rateLimitTier: creds?.rateLimitTier ?? null,
    windows: windows ?? [],
    reason: windows !== null ? null : reason,
    fetchedAt: now,
  };
}

/** Fetch live usage with the operator's token. Returns the parsed windows, or a
 *  `reason` string when the endpoint couldn't be read — never throws. */
async function fetchLiveWindows(
  token: string,
): Promise<{ windows?: UsageWindow[]; reason?: string }> {
  try {
    const res = await fetch(USAGE_ENDPOINT, {
      headers: {
        authorization: `Bearer ${token}`,
        "anthropic-beta": OAUTH_BETA,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { reason: `usage endpoint returned ${res.status}` };
    return { windows: parseUsageWindows(await res.json()) };
  } catch (err) {
    return { reason: `usage endpoint unreachable: ${(err as Error).message}` };
  }
}

/** Compute a fresh snapshot: read creds, decide whether the token is usable, and only
 *  then reach the network. The whole point is to stay read-only and degrade cleanly. */
async function computeUsage(now: number): Promise<ClaudeUsage> {
  const creds = await readCreds();
  if (!creds) return buildUsage(null, null, "no Claude Code credentials found", now);
  if (!creds.accessToken) return buildUsage(creds, null, "no access token in credentials", now);
  if (typeof creds.expiresAt === "number" && creds.expiresAt <= now) {
    // Expired — deliberately NOT refreshed here (that belongs to the CLI/daemon that
    // owns the session); the bar shows the tier and "usage unavailable" instead.
    return buildUsage(creds, null, "access token expired — sign in to Claude Code to refresh", now);
  }
  const { windows, reason } = await fetchLiveWindows(creds.accessToken);
  return buildUsage(creds, windows ?? null, reason ?? "unknown error", now);
}

let cache: { at: number; value: ClaudeUsage } | null = null;

/** The global bar's data source: a cached Claude usage/limits snapshot. Cheap to call
 *  repeatedly (TTL-cached), always resolves, and carries `available:false` + a reason
 *  whenever the live numbers can't be read. */
export async function getClaudeUsage(): Promise<ClaudeUsage> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.value;
  const value = await computeUsage(now);
  cache = { at: now, value };
  return value;
}

/** Drop the cache — for tests that vary the credential fixture between calls. */
export function resetClaudeUsageCache(): void {
  cache = null;
}
