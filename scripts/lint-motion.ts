#!/usr/bin/env bun
// Lint: all animation lives in the motion files. Transitions, keyframes and animations
// are defined once — motion.css for the CSS and motion.ts for the durations — and keyed
// off the user's motion setting so they can be softened or switched off. A `transition:`
// or `@keyframes` dropped into a component bypasses that control (and is exactly the
// kind of ad-hoc animation we don't want), so it's banned everywhere except the motion
// files.
//
// Flags CSS/JS `transition` / `animation` (and `-*` longhands) declarations and
// `@keyframes`, in src/web except motion.css / motion.ts. For a deliberate exception add
// a same-line `// lint-allow-motion: <reason>` comment. (Mantine's `transitionProps`
// component API and the words "transition"/"animation" in prose are not flagged.)
//
// Deterministic and dependency-free, like the other lint scripts.

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Glob } from "bun";

const ROOT = join(import.meta.dir, "..");
const WEB = join(ROOT, "src", "web");
const ALLOW = "lint-allow-motion";
// The two files that own animation.
const MOTION_FILES = new Set(["motion.css", "motion.ts"]);

// A `transition`/`animation` property (or `-*` longhand) set to a value, or a
// @keyframes block. The `:` requirement skips `transitionProps`, `transitionState`,
// and the words in prose.
const MOTION = /\b(transition|animation)(-[a-z-]+)?\s*:|@keyframes\b/g;

export type Violation = { file: string; line: number; col: number; match: string };

/** Flag animation declarations in `text`, honouring the same-line allow comment.
 *  Pure — exported for tests. */
export function scanText(text: string, file: string): Violation[] {
  const out: Violation[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i];
    if (lineText.includes(ALLOW)) continue;
    MOTION.lastIndex = 0;
    let m: RegExpExecArray | null = MOTION.exec(lineText);
    while (m !== null) {
      out.push({ file, line: i + 1, col: m.index + 1, match: m[0].replace(/\s*:$/, "") });
      m = MOTION.exec(lineText);
    }
  }
  return out;
}

function lint(): Violation[] {
  const violations: Violation[] = [];
  const glob = new Glob("**/*.{ts,tsx,css}");
  for (const rel of glob.scanSync(WEB)) {
    if (MOTION_FILES.has(rel)) continue;
    const abs = join(WEB, rel);
    violations.push(...scanText(readFileSync(abs, "utf8"), relative(ROOT, abs)));
  }
  return violations;
}

if (import.meta.main) runCli();

function runCli(): never {
  const found = lint();
  if (found.length === 0) {
    console.log("lint-motion: ok — all animation is in the motion files");
    process.exit(0);
  }
  console.error(
    `lint-motion: ${found.length} animation declaration(s) outside the motion files.
Animation belongs in motion.css (keyed off the motion setting via the --pm-dur-*
variables), not ad-hoc in a component. Move it there and reference a class, or for a
deliberate exception add a same-line // ${ALLOW}: <reason> comment.`,
  );
  for (const v of found) console.error(`  ${v.file}:${v.line}:${v.col}  ${v.match}`);
  process.exit(1);
}
