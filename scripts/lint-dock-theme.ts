#!/usr/bin/env bun
// Lint: dockview theme objects are imported only in themes.ts. The set of selectable
// themes — and which dockview theme each maps to — lives in themes.ts, and the rest of
// the app reads the active one through the store (useActiveTheme().dockTheme). A
// component that imports `themeAbyss` (etc.) straight from dockview-react and hardwires
// it bypasses the picker, so its dock chrome stays fixed while everything else
// re-skins (this is exactly the bug the review pane had).
//
// This flags any import of a `theme*` binding from "dockview-react" outside themes.ts.
// Deterministic and dependency-free, like the other lint scripts.

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Glob } from "bun";

const ROOT = join(import.meta.dir, "..");
const WEB = join(ROOT, "src", "web");
const ALLOW = "lint-allow-dock-theme";
const OWNER = "themes.ts"; // the one file allowed to import dockview theme objects

export type Violation = { file: string; line: number; binding: string };

/** Flag `theme*` imports from "dockview-react". Pure — exported for tests. */
export function scanText(text: string, file: string): Violation[] {
  const out: Violation[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i];
    if (lineText.includes(ALLOW)) continue;
    // Only consider lines that import from dockview-react.
    if (!/from\s+["']dockview-react["']/.test(lineText)) continue;
    for (const m of lineText.matchAll(/\btheme[A-Z][A-Za-z]*/g)) {
      out.push({ file, line: i + 1, binding: m[0] });
    }
  }
  return out;
}

function lint(): Violation[] {
  const violations: Violation[] = [];
  const glob = new Glob("**/*.{ts,tsx}");
  for (const rel of glob.scanSync(WEB)) {
    if (rel === OWNER) continue;
    const abs = join(WEB, rel);
    violations.push(...scanText(readFileSync(abs, "utf8"), relative(ROOT, abs)));
  }
  return violations;
}

if (import.meta.main) runCli();

function runCli(): never {
  const found = lint();
  if (found.length === 0) {
    console.log("lint-dock-theme: ok — dockview themes are imported only in themes.ts");
    process.exit(0);
  }
  console.error(
    `lint-dock-theme: ${found.length} dockview theme import(s) outside themes.ts.
Don't hardwire a dockview theme in a component — it won't follow the theme picker.
Read the active one from the store: useActiveTheme().dockTheme. Register any new
dockview theme in themes.ts.`,
  );
  for (const v of found) console.error(`  ${v.file}:${v.line}  ${v.binding}`);
  process.exit(1);
}
