#!/usr/bin/env bun
// Lint: the three-layer boundary. Nervo (the headless agentic core, src/nervo) must
// import neither Immersion (the shell, src/web) nor any host's schema (src/server,
// src/shared) — only itself and its one sanctioned dependency, XState (the FSM engine).
// The seam runs one way: hosts depend inward on Nervo, never the reverse. An example host
// (examples/word-host.ts) is held to the same test a third party would be — it may import
// only Nervo and XState, so it proves the core stands alone. See docs/layers.md.
//
// Enforced as: every import in a guarded file must resolve to a path *inside* one of the
// file's allowed roots, OR name a package on its small allowlist. A bare package that
// isn't allowlisted never resolves inside a root, so it's a violation — the core's only
// sanctioned dependency is XState (the FSM engine); it must never reach Immersion or a
// host's schema. This is the module-boundary lint the split is gated on ("enforce before
// any packaging").
//
// Why a custom script and not a lint rule: biome (the only linter here) has no
// custom-rule support, and this is deterministic and dependency-free like the other lint
// scripts (lint-strings, lint-dock-theme, lint-spacing).
//
// Escape hatch: a genuinely-needed cross-boundary import carries a same-line
// `// lint-allow-boundary: <reason>` comment and is skipped.

import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { Glob } from "bun";

const ROOT = join(import.meta.dir, "..");
const ALLOW = "lint-allow-boundary";

/** A guarded region: which files it covers, the roots their imports may resolve into
 *  (paths are repo-relative, POSIX), and the packages they may import. */
type Rule = { label: string; files: string; allowed: string[]; packages: string[] };

// The core's only sanctioned dependency: the FSM engine.
const CORE_DEPS = ["xstate"];

const RULES: Rule[] = [
  // The core imports only itself and XState. No src/web (Immersion), no src/server or
  // src/shared (the plan schema / host domain), no other npm dependency.
  { label: "nervo core", files: "src/nervo/**/*.ts", allowed: ["src/nervo"], packages: CORE_DEPS },
  // The example host models a third-party host: Nervo, XState, and nothing else.
  {
    label: "example host",
    files: "examples/word-host.ts",
    allowed: ["src/nervo"],
    packages: CORE_DEPS,
  },
];

export type Violation = { file: string; line: number; spec: string; label: string };

const IMPORT_RE = /(?:import|export)\s[^"']*?\sfrom\s*["']([^"']+)["']/;
const BARE_IMPORT_RE = /^\s*import\s*["']([^"']+)["']/;

/** POSIX-join + normalize a relative import against its importer's dir, then make it
 *  repo-relative. Returns null for a bare (package) specifier — those never resolve into
 *  a source root. */
function resolveSpec(fileRepoRel: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const abs = join(ROOT, dirname(fileRepoRel), spec);
  return relative(ROOT, abs).split("\\").join("/");
}

function isInside(path: string, roots: string[]): boolean {
  return roots.some((r) => path === r || path.startsWith(`${r}/`));
}

/** Is `spec` an allowlisted package (exact name or a subpath import of one)? */
function isAllowedPackage(spec: string, packages: string[]): boolean {
  return packages.some((p) => spec === p || spec.startsWith(`${p}/`));
}

/** Flag imports in `text` (for the file at repo-relative `fileRepoRel`) that resolve
 *  outside `allowed` and aren't an allowlisted `packages` import. Pure — exported for
 *  tests. */
export function scanText(
  text: string,
  fileRepoRel: string,
  allowed: string[],
  packages: string[],
  label: string,
): Violation[] {
  const out: Violation[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i];
    if (lineText.includes(ALLOW)) continue;
    const m = IMPORT_RE.exec(lineText) ?? BARE_IMPORT_RE.exec(lineText);
    if (!m) continue;
    const spec = m[1];
    const resolved = resolveSpec(fileRepoRel, spec);
    if (resolved === null) {
      if (!isAllowedPackage(spec, packages))
        out.push({ file: fileRepoRel, line: i + 1, spec, label });
    } else if (!isInside(resolved, allowed)) {
      out.push({ file: fileRepoRel, line: i + 1, spec, label });
    }
  }
  return out;
}

function lint(): Violation[] {
  const violations: Violation[] = [];
  for (const rule of RULES) {
    for (const file of new Glob(rule.files).scanSync(ROOT)) {
      const repoRel = file.split("\\").join("/");
      const text = readFileSync(join(ROOT, file), "utf8");
      violations.push(...scanText(text, repoRel, rule.allowed, rule.packages, rule.label));
    }
  }
  return violations;
}

if (import.meta.main) {
  const violations = lint();
  if (violations.length === 0) {
    console.log("lint-boundaries: ok — nervo core and the example host stay within Nervo");
  } else {
    for (const v of violations) {
      console.error(`${v.file}:${v.line} — [${v.label}] disallowed import "${v.spec}"`);
    }
    console.error(
      `\n${violations.length} boundary violation(s). Nervo must not import Immersion or the plan schema; ` +
        "the example host may import only Nervo. Add // lint-allow-boundary: <reason> to override.",
    );
    process.exit(1);
  }
}
