#!/usr/bin/env bun
// Lint: no emojis in the source. The UI uses proper icons (@tabler/icons-react),
// never emoji glyphs — they render inconsistently across platforms/fonts and look
// out of place against a real icon set. This scan flags any emoji codepoint anywhere
// in src/ (code, JSX, comments, strings) so the convention can't quietly regress.
//
// What counts as an emoji: the Unicode `Extended_Pictographic` property (covers
// 😀 💻 ☁️ 🔔 🤖 ✋ ✅ 🚫 and pictographic dingbats like ✓ ▶ ✂), plus the emoji
// presentation selector (U+FE0F), skin-tone modifiers, the ZWJ used to join emoji
// sequences, and regional-indicator letters. Ordinary typography is intentionally
// NOT flagged: arrows (→), dashes (— –), ellipsis (…), middot (·), curly quotes,
// and the geometric star (★) are not emoji and stay allowed.
//
// Like lint-strings, this is a deterministic, dependency-free scan (biome 1.9 has no
// custom-rule support). Escape hatch: a line that legitimately needs a flagged glyph
// carries a same-line `// lint-allow-emoji: <reason>` comment and is skipped.

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Glob } from "bun";

const ROOT = join(import.meta.dir, "..");
const SRC = join(ROOT, "src");
const ALLOW = "lint-allow-emoji";

// One global matcher for emoji-ish codepoints. `u` flag enables the \p{…} property.
const EMOJI = /\p{Extended_Pictographic}|‍|️|[\u{1F3FB}-\u{1F3FF}]|[\u{1F1E6}-\u{1F1FF}]/gu;

export type Violation = { file: string; line: number; col: number; char: string };

/** Flag every emoji codepoint in `text` (one file), honouring the same-line allow
 *  comment. Pure — exported for tests. */
export function scanText(text: string, file: string): Violation[] {
  const out: Violation[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i];
    if (lineText.includes(ALLOW)) continue; // suppressed
    EMOJI.lastIndex = 0;
    let m: RegExpExecArray | null = EMOJI.exec(lineText);
    while (m !== null) {
      // Skip the zero-width joiner / variation selector on their own — only report a
      // visible glyph, but they'll always sit next to one we already caught.
      if (m[0] !== "‍" && m[0] !== "️") {
        out.push({ file, line: i + 1, col: m.index + 1, char: m[0] });
      }
      m = EMOJI.exec(lineText);
    }
  }
  return out;
}

function lint(): Violation[] {
  const violations: Violation[] = [];
  const glob = new Glob("**/*.{ts,tsx}");
  for (const rel of glob.scanSync(SRC)) {
    const abs = join(SRC, rel);
    violations.push(...scanText(readFileSync(abs, "utf8"), relative(ROOT, abs)));
  }
  return violations;
}

// Run the CLI only when invoked directly; under `import` (tests) just expose helpers.
if (import.meta.main) runCli();

function runCli(): never {
  const found = lint();
  if (found.length === 0) {
    console.log("lint-emojis: ok — no emojis in src/");
    process.exit(0);
  }
  console.error(
    `lint-emojis: ${found.length} emoji(s) found.
The UI uses proper icons (@tabler/icons-react), not emoji glyphs. Replace the
emoji with an icon. If a line genuinely needs the glyph, add a same-line
// ${ALLOW}: <reason> comment.`,
  );
  for (const v of found) console.error(`  ${v.file}:${v.line}:${v.col}  ${v.char}`);
  process.exit(1);
}
