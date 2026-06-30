#!/usr/bin/env bun
// Lint: no inline <svg> outside the approved icons directory. Icons come from the set
// (@tabler/icons-react); a one-off custom glyph is fine, but it must live in its own
// dedicated component under src/web/icons/ — a named, reusable icon — not be hand-drawn
// inline in the middle of a feature component. That keeps every icon a real, swappable
// component and stops ad-hoc SVG (the cousin of the emoji glyphs we removed) from
// creeping back into the UI.
//
// Allowed: any file under src/web/icons/. Anywhere else, a stray `<svg` is flagged;
// for a deliberate exception add a same-line `// lint-allow-svg: <reason>` comment.
//
// Deterministic and dependency-free, like the other lint scripts.

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Glob } from "bun";

const ROOT = join(import.meta.dir, "..");
const WEB = join(ROOT, "src", "web");
const ALLOW = "lint-allow-svg";
// The one place custom-icon components are allowed to draw raw SVG.
const ICONS_DIR = "icons/";

// Opening of an inline SVG element (JSX or a createElement("svg")).
const SVG = /<svg[\s/>]|createElement\(\s*["']svg["']/g;

export type Violation = { file: string; line: number; col: number };

/** Flag inline <svg> in `text`, honouring the same-line allow comment. Pure —
 *  exported for tests. (Path-based exemption for the icons dir is applied by the
 *  caller, so this scans any text it's given.) */
export function scanText(text: string, file: string): Violation[] {
  const out: Violation[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i];
    if (lineText.includes(ALLOW)) continue;
    SVG.lastIndex = 0;
    let m: RegExpExecArray | null = SVG.exec(lineText);
    while (m !== null) {
      out.push({ file, line: i + 1, col: m.index + 1 });
      m = SVG.exec(lineText);
    }
  }
  return out;
}

function lint(): Violation[] {
  const violations: Violation[] = [];
  const glob = new Glob("**/*.{ts,tsx}");
  for (const rel of glob.scanSync(WEB)) {
    if (rel.startsWith(ICONS_DIR)) continue; // approved custom-icon components
    const abs = join(WEB, rel);
    violations.push(...scanText(readFileSync(abs, "utf8"), relative(ROOT, abs)));
  }
  return violations;
}

if (import.meta.main) runCli();

function runCli(): never {
  const found = lint();
  if (found.length === 0) {
    console.log("lint-svg: ok — no inline <svg> outside src/web/icons/");
    process.exit(0);
  }
  console.error(
    `lint-svg: ${found.length} inline <svg> outside src/web/icons/.
Use an icon from @tabler/icons-react. If you need a custom glyph, make it a named
component under src/web/icons/ and import it. For a one-off exception, add a
same-line // ${ALLOW}: <reason> comment.`,
  );
  for (const v of found) console.error(`  ${v.file}:${v.line}:${v.col}`);
  process.exit(1);
}
