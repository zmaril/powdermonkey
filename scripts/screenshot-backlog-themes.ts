#!/usr/bin/env bun
// Drive headless Chromium over a running supervisor and screenshot the Backlog under
// every theme in themes.ts, so the proposal-review surface (ghost cards + milestone, the
// teal dashed borders, "Proposed: …" strips, ✓/✗ buttons, the craft editor) can be
// checked for legibility in each. Pair with seed-proposal-surface.ts to populate the
// surface first. Container-only (the remote container can't reach localhost from a real
// browser — this is the headless path CLAUDE.md describes).
//
//   PM_URL=http://localhost:4500 OUT=/tmp/shots bun run scripts/screenshot-backlog-themes.ts
//
// Each theme renders in its own browser context with the theme pre-seeded into
// localStorage *before* the app boots (addInitScript) — otherwise the still-running
// previous page races the store and clobbers the selection.

import { Glob } from "bun";
import { chromium } from "playwright-core";
import { THEME_ORDER } from "../src/web/themes.ts";

const PM_URL = process.env.PM_URL ?? "http://localhost:4500";
const OUT = process.env.OUT ?? "/tmp/backlog-themes";

// Resolve Playwright's bundled Chromium (build number varies across images).
const chrome = [...new Glob("chromium-*/chrome-linux/chrome").scanSync("/opt/pw-browsers")]
  .map((p) => `/opt/pw-browsers/${p}`)
  .sort()
  .at(-1);
if (!chrome) throw new Error("no chromium under /opt/pw-browsers — is Playwright installed?");

const browser = await chromium.launch({ executablePath: chrome });
for (const theme of THEME_ORDER) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1150 } });
  await ctx.addInitScript((t) => {
    localStorage.setItem(
      "pm-ui",
      JSON.stringify({
        state: { theme: t, density: "default", fontScale: "md", motion: "full" },
        version: 0,
      }),
    );
  }, theme);
  const page = await ctx.newPage();
  await page.goto(PM_URL, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  await page.getByText("Backlog", { exact: true }).first().click();
  await page.waitForTimeout(400);
  try {
    await page.getByText("Grouped", { exact: true }).first().click({ timeout: 1500 });
  } catch {}
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/${theme}.png`, fullPage: true });
  console.log(`shot ${theme}`);
  await ctx.close();
}
await browser.close();
console.log(`\nwrote ${THEME_ORDER.length} screenshots to ${OUT}`);
