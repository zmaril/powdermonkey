#!/usr/bin/env bun
// Lint: no hardcoded hex colors in UI components. The design is driven by one set of
// theme tokens — the Mantine palette (var(--mantine-color-*)) and the app's `--pm-*`
// custom properties (themes.ts) — which re-skin together when the editor theme is
// switched, light themes included. A raw `#1e1e1e` in a component opts out of all of
// that: it stays put under every theme and reads wrong (often invisible) under some.
//
// This scan flags hex color literals (#rgb, #rgba, #rrggbb, #rrggbbaa) anywhere in
// src/web EXCEPT the palette definitions themselves (theme.ts / themes.ts / theme.css,
// which are where the colors are allowed to live). Use a Mantine var or a `--pm-*`
// token instead. For a genuinely fixed, non-themed color (an alert, an embedded
// third-party surface), add a same-line `// lint-allow-color: <reason>` comment.
//
// Like the other lint scripts, this is deterministic and dependency-free (biome 1.9
// has no custom-rule support).

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Glob } from "bun";

const ROOT = join(import.meta.dir, "..");
const WEB = join(ROOT, "src", "web");
const ALLOW = "lint-allow-color";
// The palette lives in these files — hex is expected and allowed there.
const PALETTE_FILES = new Set(["theme.ts", "themes.ts", "theme.css"]);

// A hex color: # followed by exactly 3, 4, 6 or 8 hex digits, not part of a longer run.
const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/g;

export type Violation = { file: string; line: number; col: number; value: string };

/** Flag every hex color literal in `text` (one file), honouring the same-line allow
 *  comment. Pure — exported for tests. */
export function scanText(text: string, file: string): Violation[] {
  const out: Violation[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i];
    if (lineText.includes(ALLOW)) continue; // suppressed
    HEX.lastIndex = 0;
    let m: RegExpExecArray | null = HEX.exec(lineText);
    while (m !== null) {
      out.push({ file, line: i + 1, col: m.index + 1, value: m[0] });
      m = HEX.exec(lineText);
    }
  }
  return out;
}

function lint(): Violation[] {
  const violations: Violation[] = [];
  const glob = new Glob("**/*.{ts,tsx,css}");
  for (const rel of glob.scanSync(WEB)) {
    if (PALETTE_FILES.has(rel)) continue;
    const abs = join(WEB, rel);
    violations.push(...scanText(readFileSync(abs, "utf8"), relative(ROOT, abs)));
  }
  return violations;
}

// Run the CLI only when invoked directly; under `import` (tests) just expose helpers.
if (import.meta.main) runCli();

function runCli(): never {
  const found = lint();
  if (found.length === 0) {
    console.log("lint-colors: ok — no hardcoded hex colors in src/web/");
    process.exit(0);
  }
  console.error(
    `lint-colors: ${found.length} hardcoded hex color(s) found.
Components must use theme tokens so they re-skin with the editor theme — a Mantine
var (var(--mantine-color-*)) or a --pm-* token (themes.ts). If a color is genuinely
fixed (an alert, an embedded third-party surface), add a same-line
// ${ALLOW}: <reason> comment.`,
  );
  for (const v of found) console.error(`  ${v.file}:${v.line}:${v.col}  ${v.value}`);
  process.exit(1);
}
