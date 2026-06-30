#!/usr/bin/env bun
// Headless react-scan report: drive the UI with the re-render diagnostic on and
// print a per-component render tally — "what react-scan has to say" without a
// human watching the overlay.
//
// react-scan only instruments a *development* React build, so this expects a
// server serving the dev bundle:
//
//   bun run build:web:scan                 # build with NODE_ENV=development
//   bun run dev                            # (or `serve`) on http://localhost:4500
//   bun run scripts/react-scan-report.ts   # drives ?scan and prints the table
//
// PM_SCAN_URL overrides the target (default http://localhost:4500/?scan).
// The page side of this — gating, the onRender tally on window.__reactScan — is
// in src/web/react-scan.ts; this script just exercises the app and reads it back.

import { chromium } from "playwright-core";

const URL = process.env.PM_SCAN_URL ?? "http://localhost:4500/?scan";
const CHROME = process.env.PM_CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(2500);

const installed = await page.evaluate(
  () => !!(window as unknown as { __reactScan?: unknown }).__reactScan,
);
if (!installed) {
  console.error(
    "react-scan did not install — is this a dev build (`bun run build:web:scan`) and the URL on ?scan?",
  );
  await browser.close();
  process.exit(1);
}

const pause = (ms: number) => page.waitForTimeout(ms);
async function click(text: string) {
  try {
    await page.getByText(text, { exact: true }).first().click({ timeout: 4000 });
  } catch {
    /* a tab/control may be absent depending on plan state — keep going */
  }
}

// A short, realistic burst: re-lay the tree, churn row state, type, flip panes.
await click("Backlog");
await pause(900);
for (let i = 0; i < 4; i++) {
  await click(i % 2 === 0 ? "Flat" : "Grouped");
  await pause(500);
}
const textarea = await page.locator("textarea, [contenteditable='true']").first().boundingBox();
if (textarea) {
  await page.mouse.click(textarea.x + 120, textarea.y + 24);
  await page.keyboard.type("react-scan render probe", { delay: 40 });
  await pause(700);
}
for (const tab of ["Plan", "Active", "Archive", "Backlog"]) {
  await click(tab);
  await pause(700);
}

type Row = { name: string; renders: number; unnecessary: number; time: number };
const report: Row[] = await page.evaluate(() => {
  const m = (window as unknown as { __reactScan?: Map<string, Omit<Row, "name">> }).__reactScan;
  return m ? [...m.entries()].map(([name, v]) => ({ name, ...v })) : [];
});
report.sort((a, b) => b.renders - a.renders);

const pad = (s: string, n: number) => s.slice(0, n).padEnd(n);
const padL = (s: string, n: number) => s.padStart(n);
console.log(pad("component", 36) + padL("renders", 9) + padL("time(ms)", 10));
console.log("-".repeat(55));
for (const r of report) {
  console.log(pad(r.name, 36) + padL(String(r.renders), 9) + padL(r.time.toFixed(1), 10));
}
console.log("-".repeat(55));
const total = report.reduce((s, r) => s + r.renders, 0);
console.log(pad("TOTAL", 36) + padL(String(total), 9));
console.log(`\n${report.length} components, ${total} renders`);

await browser.close();
