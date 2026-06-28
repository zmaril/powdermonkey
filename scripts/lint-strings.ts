#!/usr/bin/env bun
// Lint: no bare string args — enums / declared string types only.
//
// The closed vocabularies (SessionKind, SessionState, PrState, …) are declared
// once as `as const` objects in src/shared/types.ts. The meaning of those values
// is supposed to live in the *type*, used as an enum member — never re-spelled as
// a magic string literal at a call site or comparison. This scan reads the
// vocabularies out of types.ts and flags any string literal elsewhere in src/
// whose value is a member of one of them, so the enum-everywhere convention
// can't quietly regress.
//
// Why a custom script and not a lint rule: biome (the only linter here, pinned to
// 1.9) has no custom-rule support, and an eslint + type-aware-parser stack for a
// single rule is more machinery than the check is worth. This is deterministic,
// dependency-free, and targets exactly the smell.
//
// Escape hatch: a string that legitimately equals an enum value without being one
// (a display label, a UI title, a DB column name) carries a same-line
// `// lint-allow-string: <reason>` comment and is skipped. See docs/typed-strings.md.

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Glob } from "bun";

const ROOT = join(import.meta.dir, "..");
const SRC = join(ROOT, "src");
const TYPES_FILE = join(SRC, "shared", "types.ts");
const ALLOW = "lint-allow-string";

/** Every double-quoted string in types.ts is an enum value — the file holds only
 *  the `as const` vocabularies and their derived type aliases. */
export function enumValues(): Set<string> {
  const text = readText(TYPES_FILE);
  const values = new Set<string>();
  for (const lit of stringLiterals(text)) values.add(lit.value);
  return values;
}

type Literal = { value: string; line: number };

// A `/` starts a regex (rather than being division) when the previous
// significant code character is an operator/opener — never after a value
// (identifier, `)`, `]`, a closed string, etc). Every regex in this codebase
// sits in call position (`.match(/…/)`, `.replace(/…/)`, `.split(/…/)`), so this
// is enough to skip regex bodies — whose contents (backticks, quotes) would
// otherwise desync the string scan. `<` and `>` are deliberately excluded: in
// .tsx they open/close JSX tags (`</Text>`), and no regex here follows them.
const REGEX_PREV = new Set([
  "",
  "(",
  "{",
  "[",
  ",",
  ";",
  ":",
  "=",
  "!",
  "&",
  "|",
  "?",
  "+",
  "-",
  "*",
  "%",
  "~",
  "^",
  "\n",
]);

/** Walk the source character by character, yielding the contents of single- and
 *  double-quoted string literals with their 1-based line number. Comments,
 *  template literals, and regex literals are skipped so a value mentioned in
 *  prose, a `${}` template, or a regex character class never counts as a magic
 *  literal. */
export function stringLiterals(src: string): Literal[] {
  const out: Literal[] = [];
  let line = 1;
  let i = 0;
  let prev = ""; // last significant code char (comments/whitespace excluded)
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === " " || c === "\t" || c === "\r") {
      i++;
    } else if (c === "\n") {
      line++;
      prev = "\n";
      i++;
    } else if (c === "/" && next === "/") {
      while (i < n && src[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") line++;
        i++;
      }
      i += 2;
    } else if (c === "/" && REGEX_PREV.has(prev)) {
      // Regex literal: skip to the terminating `/`, honouring escapes and
      // `[…]` classes (a `/` inside a class doesn't end the regex).
      i++;
      let inClass = false;
      while (i < n && (inClass || src[i] !== "/")) {
        if (src[i] === "\\") i++;
        else if (src[i] === "[") inClass = true;
        else if (src[i] === "]") inClass = false;
        else if (src[i] === "\n") line++;
        i++;
      }
      i++;
      prev = "/";
    } else if (c === "`") {
      // Skip template literals wholesale — enum values aren't templated.
      i++;
      while (i < n && src[i] !== "`") {
        if (src[i] === "\\") i++;
        else if (src[i] === "\n") line++;
        i++;
      }
      i++;
      prev = "`";
    } else if (c === '"' || c === "'") {
      const quote = c;
      const startLine = line;
      i++;
      let value = "";
      while (i < n && src[i] !== quote) {
        if (src[i] === "\\") {
          value += src[i + 1] ?? "";
          i += 2;
          continue;
        }
        if (src[i] === "\n") line++;
        value += src[i];
        i++;
      }
      i++;
      out.push({ value, line: startLine });
      prev = quote;
    } else {
      prev = c;
      i++;
    }
  }
  return out;
}

function readText(path: string): string {
  return readFileSync(path, "utf8");
}

export type Violation = { file: string; line: number; value: string };

/** Flag every enum-value string literal in `text` (one file), honouring the
 *  same-line allow comment. Pure — exported for tests. */
export function scanText(text: string, file: string, values: Set<string>): Violation[] {
  const out: Violation[] = [];
  const lines = text.split("\n");
  for (const lit of stringLiterals(text)) {
    if (!values.has(lit.value)) continue;
    if (lines[lit.line - 1]?.includes(ALLOW)) continue; // suppressed
    out.push({ file, line: lit.line, value: lit.value });
  }
  return out;
}

function lint(): Violation[] {
  const values = enumValues();
  const violations: Violation[] = [];
  const glob = new Glob("**/*.{ts,tsx}");
  for (const rel of glob.scanSync(SRC)) {
    const abs = join(SRC, rel);
    if (abs === TYPES_FILE) continue; // the definition itself
    violations.push(...scanText(readText(abs), relative(ROOT, abs), values));
  }
  return violations;
}

// Run the CLI only when invoked directly; under `import` (tests) just expose helpers.
if (import.meta.main) runCli();

function runCli(): never {
  const found = lint();
  if (found.length === 0) {
    console.log("lint-strings: ok — no bare enum-value string literals in src/");
    process.exit(0);
  }

  console.error(
    `lint-strings: ${found.length} bare enum-value string literal(s) found.
These values belong to an enum in src/shared/types.ts — use the enum member
(e.g. SessionState.Stopped instead of "stopped"). If a string genuinely is not
an enum value (a display label, title, or DB column), add a same-line
// ${ALLOW}: <reason> comment. See docs/typed-strings.md.`,
  );
  for (const v of found) console.error(`  ${v.file}:${v.line}  "${v.value}"`);
  process.exit(1);
}
