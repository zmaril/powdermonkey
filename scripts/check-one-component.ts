#!/usr/bin/env bun
// One React component per file.
//
// Biome (the repo's linter) has no equivalent of ESLint's react/no-multi-comp,
// and pulling in the whole ESLint toolchain for a single rule would be at odds
// with this repo's deliberately small footprint (Bun + Biome, no ESLint). So
// this is a tiny standalone check instead: it scans the .tsx/.jsx sources and
// fails if any file declares more than one React component.
//
// "Component" here leans on the codebase's own naming convention, which cleanly
// separates the three kinds of top-level declaration:
//   • components — PascalCase functions/arrows that return JSX  → counted
//   • helpers / hooks — camelCase (prDot, groupBySession, useX) → ignored
//   • constant maps — UPPER_SNAKE (STATUS_COLOR, KIND_ICON)      → ignored
// A component is a top-level (column-0) `function Name` declaration, or a
// top-level `const Name = …` bound to a function, whose Name is PascalCase
// (starts uppercase, contains a lowercase letter, no underscores). Nested /
// inline components are intentionally not counted — the rule is about what a
// module exposes, not render-prop closures.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const FN_DECL = /^(?:export\s+)?(?:default\s+)?function\s+([A-Za-z0-9_$]+)/;
const CONST_DECL = /^(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*(?::[^=]+)?=\s*(.+)$/;

/** PascalCase: starts uppercase, has a lowercase letter, no underscores. This is
 *  what tells a component (IdTag, PrRow, App) apart from an UPPER_SNAKE constant
 *  (STATUS_COLOR) or a camelCase helper/hook (prDot, useConnectionWatch). */
function isComponentName(name: string): boolean {
  return /^[A-Z][A-Za-z0-9]*$/.test(name) && /[a-z]/.test(name);
}

/** Does the right-hand side of a `const` begin a function (arrow or expression)? */
function looksLikeFunction(rhs: string): boolean {
  const s = rhs.trim();
  return (
    /^(?:async\s+)?function\b/.test(s) || // const X = function () {…}
    /^(?:async\s+)?\(/.test(s) || // const X = (props) => …
    /^(?:async\s+)?[A-Za-z_$][\w$]*\s*=>/.test(s) || // const X = props => …
    /^(?:React\.)?(?:memo|forwardRef)\b/.test(s) // const X = memo(…) / forwardRef(…)
  );
}

/** The names of the top-level React components declared in a source string. */
export function componentNames(source: string): string[] {
  const names: string[] = [];
  for (const line of source.split("\n")) {
    const fn = FN_DECL.exec(line);
    if (fn && isComponentName(fn[1])) {
      names.push(fn[1]);
      continue;
    }
    const c = CONST_DECL.exec(line);
    if (c && isComponentName(c[1]) && looksLikeFunction(c[2])) {
      names.push(c[1]);
    }
  }
  return names;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".tsx") || full.endsWith(".jsx")) out.push(full);
  }
  return out;
}

/** Files under `root` that declare more than one component, with the names found. */
export function findOffenders(root: string): { file: string; components: string[] }[] {
  return walk(root)
    .map((file) => ({ file, components: componentNames(readFileSync(file, "utf8")) }))
    .filter((r) => r.components.length > 1);
}

if (import.meta.main) {
  const root = process.argv[2] ?? "src";
  const offenders = findOffenders(root);
  if (offenders.length === 0) {
    console.log(`✓ one component per file (${root})`);
    process.exit(0);
  }
  console.error("✗ files declaring more than one React component:\n");
  for (const { file, components } of offenders) {
    console.error(`  ${file}`);
    console.error(`    ${components.join(", ")}`);
  }
  console.error(
    `\n${offenders.length} file(s) with multiple components. Split each into one component per file.`,
  );
  process.exit(1);
}
