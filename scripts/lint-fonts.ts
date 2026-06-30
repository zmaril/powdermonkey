#!/usr/bin/env bun
// Lint: no inline font-family stacks in components. Typography is a design token like
// color — the app's fonts are defined once in theme.ts (fontFamily / fontFamilyMonospace)
// and exposed as var(--mantine-font-family) / var(--mantine-font-family-monospace). A
// component that re-spells "ui-monospace, …" inline drifts from that single source and
// won't follow a future font change.
//
// This flags any `fontFamily:` / `font-family:` whose value isn't one of those vars,
// across src/web EXCEPT the token definitions (theme.ts / theme.css). For a place that
// genuinely needs a literal stack (e.g. a canvas renderer that can't resolve a CSS
// var), add a same-line `// lint-allow-font: <reason>` comment.
//
// Deterministic and dependency-free, like the other lint scripts.

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Glob } from "bun";

const ROOT = join(import.meta.dir, "..");
const WEB = join(ROOT, "src", "web");
const ALLOW = "lint-allow-font";
const PALETTE_FILES = new Set(["theme.ts", "theme.css"]);

// A font-family declaration (JS `fontFamily:` or CSS `font-family:`) and its value up
// to the line's end / closing brace / quote — enough to check what it's set to.
const DECL = /(?:font-family|fontFamily)\s*:\s*([^;}\n]+)/gi;

export type Violation = { file: string; line: number; col: number; value: string };

/** Flag every inline font-family that isn't the Mantine font token, honouring the
 *  same-line allow comment. Pure — exported for tests. */
export function scanText(text: string, file: string): Violation[] {
  const out: Violation[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i];
    if (lineText.includes(ALLOW)) continue; // suppressed
    DECL.lastIndex = 0;
    let m: RegExpExecArray | null = DECL.exec(lineText);
    while (m !== null) {
      const value = m[1].trim();
      // Strip surrounding JS-string quotes / trailing comma before comparing.
      const bare = value.replace(/["',]/g, "").trim();
      // Allowed: the Mantine font-family tokens (sans or monospace) and `inherit`.
      if (!/^var\(--mantine-font-family(-monospace)?\)$/.test(bare) && bare !== "inherit") {
        out.push({ file, line: i + 1, col: m.index + 1, value });
      }
      m = DECL.exec(lineText);
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

if (import.meta.main) runCli();

function runCli(): never {
  const found = lint();
  if (found.length === 0) {
    console.log("lint-fonts: ok — no inline font-family stacks in src/web/");
    process.exit(0);
  }
  console.error(
    `lint-fonts: ${found.length} inline font-family declaration(s) found.
Use the font token instead — var(--mantine-font-family) or
var(--mantine-font-family-monospace) (defined in theme.ts). If a literal stack is
genuinely required (e.g. a canvas renderer), add a same-line
// ${ALLOW}: <reason> comment.`,
  );
  for (const v of found) console.error(`  ${v.file}:${v.line}:${v.col}  ${v.value}`);
  process.exit(1);
}
