import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The module reads its paths/endpoint from env at import time, so set them first: a
// fixture credentials file we rewrite per case, and a local stand-in for the usage
// endpoint so the live path is exercised without a real token or the real API.
const dir = mkdtempSync(join(tmpdir(), "pm-usage-"));
const credsPath = join(dir, "creds.json");
process.env.PM_CLAUDE_CREDENTIALS = credsPath;

const server = Bun.serve({
  port: 0,
  fetch(req) {
    // Only the exact bearer + beta header the real endpoint requires gets data.
    if (req.headers.get("authorization") !== "Bearer good-token") {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    }
    return Response.json({
      five_hour: {
        utilization: 42,
        resets_at: 1782900000,
        scope: { model: { display_name: "Opus" } },
      },
      seven_day: { utilization: 0.8, resets_at: "2026-07-10T00:00:00Z" },
      junk: "not a window",
    });
  },
});
process.env.PM_CLAUDE_USAGE_URL = `http://localhost:${server.port}/api/oauth/usage`;

const {
  normalizeUtilization,
  normalizeResetsAt,
  parseUsageWindows,
  buildUsage,
  getClaudeUsage,
  resetClaudeUsageCache,
} = await import("../src/server/claude-usage.ts");

type Creds = Record<string, unknown>;
function writeCreds(claudeAiOauth: Creds): void {
  writeFileSync(credsPath, JSON.stringify({ claudeAiOauth }));
  resetClaudeUsageCache();
}

afterAll(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

test("normalizeUtilization reads percent and fraction, clamps, rejects junk", () => {
  expect(normalizeUtilization(42)).toBeCloseTo(0.42);
  expect(normalizeUtilization(0.8)).toBeCloseTo(0.8);
  expect(normalizeUtilization(150)).toBe(1); // over-cap clamps to full
  expect(normalizeUtilization(-1)).toBeNull();
  expect(normalizeUtilization("nope")).toBeNull();
});

test("normalizeResetsAt reads epoch seconds, epoch ms, and ISO", () => {
  expect(normalizeResetsAt(1782900000)).toBe(1782900000 * 1000); // seconds → ms
  expect(normalizeResetsAt(1782900000000)).toBe(1782900000000); // already ms
  expect(normalizeResetsAt("2026-07-10T00:00:00Z")).toBe(Date.parse("2026-07-10T00:00:00Z"));
  expect(normalizeResetsAt(undefined)).toBeNull();
  expect(normalizeResetsAt("garbage")).toBeNull();
});

test("parseUsageWindows picks window-shaped entries, labels them, skips the rest", () => {
  const windows = parseUsageWindows({
    five_hour: { utilization: 42, resets_at: 1782900000 },
    seven_day: { utilization: 0.8, resets_at: "2026-07-10T00:00:00Z" },
    scoped: { percent: 10, resets_at: 0, scope: { model: { display_name: "Sonnet" } } },
    junk: "not a window",
  });
  const byLabel = new Map(windows.map((w) => [w.label, w]));
  expect([...byLabel.keys()].sort()).toEqual(["5h", "7d", "Sonnet"]);
  expect(byLabel.get("5h")?.utilization).toBeCloseTo(0.42);
  expect(byLabel.get("7d")?.resetsAt).toBe(Date.parse("2026-07-10T00:00:00Z"));
  expect(byLabel.get("Sonnet")?.utilization).toBeCloseTo(0.1);
});

test("buildUsage: null windows means unavailable + reason; a list means available", () => {
  const creds = { subscriptionType: "max", rateLimitTier: "default_claude_max_20x" };
  const down = buildUsage(creds, null, "token expired", 1000);
  expect(down.available).toBe(false);
  expect(down.reason).toBe("token expired");
  expect(down.subscriptionType).toBe("max"); // tier survives the degradation
  expect(down.windows).toEqual([]);

  const up = buildUsage(
    creds,
    [{ label: "5h", utilization: 0.5, resetsAt: null }],
    "ignored",
    1000,
  );
  expect(up.available).toBe(true);
  expect(up.reason).toBeNull();
  expect(up.rateLimitTier).toBe("default_claude_max_20x");
});

test("getClaudeUsage: valid token reads live windows off the endpoint", async () => {
  writeCreds({
    accessToken: "good-token",
    expiresAt: Date.now() + 3_600_000,
    subscriptionType: "max",
    rateLimitTier: "default_claude_max_20x",
  });
  const usage = await getClaudeUsage();
  expect(usage.available).toBe(true);
  expect(usage.subscriptionType).toBe("max");
  expect(usage.windows.map((w) => w.label).sort()).toEqual(["5h", "7d"]);
});

test("getClaudeUsage: expired token degrades but keeps the tier", async () => {
  writeCreds({
    accessToken: "good-token",
    expiresAt: Date.now() - 1000, // expired — must NOT be refreshed, just degraded
    subscriptionType: "max",
    rateLimitTier: "default_claude_max_20x",
  });
  const usage = await getClaudeUsage();
  expect(usage.available).toBe(false);
  expect(usage.reason).toContain("expired");
  expect(usage.rateLimitTier).toBe("default_claude_max_20x");
});

test("getClaudeUsage: a rejected token degrades with the endpoint status", async () => {
  writeCreds({
    accessToken: "stale-token",
    expiresAt: Date.now() + 3_600_000,
    subscriptionType: "pro",
  });
  const usage = await getClaudeUsage();
  expect(usage.available).toBe(false);
  expect(usage.reason).toContain("401");
  expect(usage.subscriptionType).toBe("pro");
});

test("getClaudeUsage: no access token is a clean degraded state", async () => {
  writeCreds({ subscriptionType: "max" });
  const usage = await getClaudeUsage();
  expect(usage.available).toBe(false);
  expect(usage.reason).toContain("no access token");
});
