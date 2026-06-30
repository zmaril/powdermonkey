#!/usr/bin/env bun
// Lint: no raw-px values in Mantine spacing props. Spacing is a design token, and the
// user's density control scales the spacing scale (theme.ts / appearance.ts) — but a
// hardcoded `gap={6}` is a fixed 6px that ignores the scale and won't budge when the
// density changes. So spacing props must use a scale token (hair / tight / snug / cozy
// / xs / sm / md / lg / xl), never a raw number.
//
// Flags `gap|p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|spacing = {<number>}` in src/web,
// except `{0}` (an unambiguous "none"). For a genuine fixed offset (e.g. aligning to
// another element's width), add a same-line `// lint-allow-spacing: <reason>` comment —
// or move it into a `style` rule, which isn't a spacing token.
//
// Deterministic and dependency-free, like the other lint scripts.

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Glob } from "bun";

const ROOT = join(import.meta.dir, "..");
const WEB = join(ROOT, "src", "web");
const ALLOW = "lint-allow-spacing";

// A Mantine spacing prop set to a numeric literal: gap={6}, py={8}, mt={4}, …
// Longer prop names first so the alternation prefers `gap`/`px` over `p`.
const SPACING = /\b(gap|spacing|px|py|pt|pb|pl|pr|mx|my|mt|mb|ml|mr|p|m)=\{(\d+)\}/g;

export type Violation = { file: string; line: number; col: number; prop: string; value: string };

/** Flag raw-px spacing props in `text`, honouring the same-line allow comment and
 *  permitting {0}. Pure — exported for tests. */
export function scanText(text: string, file: string): Violation[] {
  const out: Violation[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i];
    if (lineText.includes(ALLOW)) continue;
    SPACING.lastIndex = 0;
    let m: RegExpExecArray | null = SPACING.exec(lineText);
    while (m !== null) {
      if (m[2] !== "0") {
        out.push({ file, line: i + 1, col: m.index + 1, prop: m[1], value: m[2] });
      }
      m = SPACING.exec(lineText);
    }
  }
  return out;
}

function lint(): Violation[] {
  const violations: Violation[] = [];
  const glob = new Glob("**/*.{ts,tsx}");
  for (const rel of glob.scanSync(WEB)) {
    const abs = join(WEB, rel);
    violations.push(...scanText(readFileSync(abs, "utf8"), relative(ROOT, abs)));
  }
  return violations;
}

if (import.meta.main) runCli();

function runCli(): never {
  const found = lint();
  if (found.length === 0) {
    console.log("lint-spacing: ok — no raw-px spacing in src/web/");
    process.exit(0);
  }
  console.error(
    `lint-spacing: ${found.length} raw-px spacing prop(s) found.
Use a spacing token so the density control can scale it: hair / tight / snug / cozy /
xs / sm / md / lg / xl (e.g. gap="snug" instead of gap={6}). For a genuine fixed offset,
add a same-line // ${ALLOW}: <reason> comment.`,
  );
  for (const v of found) console.error(`  ${v.file}:${v.line}:${v.col}  ${v.prop}={${v.value}}`);
  process.exit(1);
}
