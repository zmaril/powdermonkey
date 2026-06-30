#!/usr/bin/env bun
// Human-readable companion to tests/theme-contrast.test.ts: print the WCAG contrast of
// every theme's text/dimmed roles against its surfaces (page / pane / card / terminal),
// flagging any pair under threshold. The test is the gate (CI); this is for eyeballing a
// palette while tuning it. Same math (src/web/contrast.ts), same thresholds.

import { contrastRatio } from "../src/web/contrast.ts";
import { THEMES, THEME_ORDER } from "../src/web/themes.ts";

const BODY_MIN = 4.5;
const DIMMED_MIN = 3.0;

const cell = (v: number, min: number) => `${v < min ? "*" : " "}${v.toFixed(2)}`.padStart(7);

let failures = 0;
console.log(
  "theme".padEnd(18),
  ["txt/page", "txt/pane", "txt/card", "txt/term", "dim/page", "dim/pane", "dim/card"]
    .map((h) => h.padStart(7))
    .join(" "),
);
for (const key of THEME_ORDER) {
  const t = THEMES[key];
  const [text, , dimmed] = t.dark;
  const page = t.dark[8];
  const pane = t.dark[7];
  const card = t.dark[6];
  const pairs: [number, number][] = [
    [contrastRatio(text, page), BODY_MIN],
    [contrastRatio(text, pane), BODY_MIN],
    [contrastRatio(text, card), BODY_MIN],
    [contrastRatio(text, t.terminalBg), BODY_MIN],
    [contrastRatio(dimmed, page), DIMMED_MIN],
    [contrastRatio(dimmed, pane), DIMMED_MIN],
    [contrastRatio(dimmed, card), DIMMED_MIN],
  ];
  for (const [v, min] of pairs) if (v < min) failures++;
  console.log(key.padEnd(18), pairs.map(([v, min]) => cell(v, min)).join(" "));
}
console.log(`\n(* = below threshold — body ${BODY_MIN}:1, dimmed ${DIMMED_MIN}:1)`);
if (failures > 0) {
  console.error(`\naudit-theme-contrast: ${failures} pair(s) below threshold.`);
  process.exit(1);
}
console.log("\naudit-theme-contrast: ok — every theme clears contrast on every surface.");
