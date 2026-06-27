import { chromium } from "playwright-core";
import type { SessionState } from "../shared/types.ts";

// Playwright is the bridge to Claude Code Web. It opens a session headless,
// using a persistent browser profile so it inherits your logged-in Claude auth,
// and reads the session's status back. Auto-clicking "Try Again" with backoff is
// a later layer — this only *reads*.
//
// ┌─ SEAM: confirm against your spike ──────────────────────────────────────┐
// │ These selectors are the Claude Code Web contract the spike pinned down.  │
// │ They're the one thing here that can drift when the web UI changes; keep   │
// │ them in this block so a change is a one-line edit.                        │
// └──────────────────────────────────────────────────────────────────────────┘
const SELECTORS = {
  // Present and visible when inference has finished and the session is parked.
  tryAgain: 'button:has-text("Try again")',
  // Present while the model is actively streaming a response.
  running: '[data-testid="stop-button"], button:has-text("Stop")',
};

// Persistent profile dir so the headless browser carries your Claude login.
const PROFILE_DIR = process.env.PM_BROWSER_PROFILE ?? "data/browser-profile";
// playwright-core ships no browser; point at an installed Chrome/Chromium.
const CHROME = process.env.PM_CHROME_PATH;

export type StatusResult = { ok: true; state: SessionState } | { ok: false; error: string };

export async function readSessionStatus(url: string): Promise<StatusResult> {
  let ctx: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | null = null;
  try {
    ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: true,
      ...(CHROME ? { executablePath: CHROME } : { channel: "chrome" }),
    });
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });

    if (
      await page
        .locator(SELECTORS.tryAgain)
        .first()
        .isVisible()
        .catch(() => false)
    ) {
      return { ok: true, state: "waiting" };
    }
    if (
      await page
        .locator(SELECTORS.running)
        .first()
        .isVisible()
        .catch(() => false)
    ) {
      return { ok: true, state: "running" };
    }
    return { ok: true, state: "idle" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    await ctx?.close();
  }
}
