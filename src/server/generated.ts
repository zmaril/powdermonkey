// Which files a PR diff should collapse by default — the "generated / vendored"
// set GitHub hides until you ask for it (bun.lock, package-lock.json, built
// bundles, node_modules/…). This is the ruleset; ReviewPane uses it to default a
// file to collapsed while still letting the operator expand it.
//
// GitHub leans on github-linguist (lib/linguist/generated.rb + vendor.yml) plus a
// repo's own .gitattributes (`linguist-generated` / `linguist-vendored`). We can't
// reproduce linguist's content sniffing (it reads whole-file bytes; we only hold a
// PR's per-file patch), so we cover the parts that are decidable from the diff
// payload — path/name rules + a minified-by-line-length heuristic — and honour an
// explicit .gitattributes when we can fetch one. See docs/generated-files.md.

/** Why a file collapses — surfaced in the file header so the operator knows it
 *  wasn't hidden arbitrarily. */
export type GeneratedReason =
  | "lockfile"
  | "vendored"
  | "minified"
  | "sourcemap"
  | "generated"
  | "gitattributes"
  | "large";

export type Classification = { generated: boolean; reason: GeneratedReason | null };

/** Human label for a reason, shown on the collapsed file header. */
export function reasonLabel(reason: GeneratedReason): string {
  switch (reason) {
    case "lockfile":
      return "lockfile";
    case "vendored":
      return "vendored";
    case "minified":
      return "minified";
    case "sourcemap":
      return "source map";
    case "generated":
      return "generated";
    case "gitattributes":
      return "marked generated";
    case "large":
      return "large diff";
  }
}

const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

// Dependency lockfiles — fully tool-written, reviewed by the change that drives
// them, not line-by-line. Matched on basename, case-insensitively (Cargo.lock,
// Gemfile.lock, …). Mirrors the lockfile set in linguist's generated.rb.
const LOCKFILES = new Set(
  [
    "package-lock.json",
    "npm-shrinkwrap.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "bun.lock",
    "bun.lockb",
    "gemfile.lock",
    "composer.lock",
    "cargo.lock",
    "podfile.lock",
    "package.resolved",
    "flake.lock",
    "go.sum",
    "poetry.lock",
    "pipfile.lock",
    "pdm.lock",
    "uv.lock",
    "pixi.lock",
    "deno.lock",
    "mix.lock",
    "pubspec.lock",
    "packages.lock.json",
    "gradle.lockfile",
    "gopkg.lock",
    "glide.lock",
    ".terraform.lock.hcl",
    "module.bazel.lock",
  ].map((n) => n.toLowerCase()),
);

// Third-party trees: anything under one of these path segments is vendored. A
// subset of linguist's vendor.yml — the directory rules, which are what actually
// show up committed in a repo (the per-library `jquery*.js` rules are sniffed from
// content we don't have).
const VENDOR_DIRS = [
  "node_modules",
  "bower_components",
  "jspm_packages",
  "vendor",
  "vendors",
  "third_party",
  "Godeps",
];

// Generated-code suffixes we can decide from the name alone (protobuf, gRPC, .NET
// designer, codegen'd Dart). Content markers like `// Code generated` need the file
// body, so they're out of scope here.
const GENERATED_SUFFIXES = [
  ".pb.go",
  ".pb.cc",
  ".pb.h",
  "_pb2.py",
  "_pb2_grpc.py",
  ".designer.cs",
  ".designer.vb",
  ".g.dart",
  ".freezed.dart",
];

/** Average length of the patch's added (`+`) content lines. Minified bundles and
 *  generated blobs pack everything onto a few enormous lines; linguist calls a file
 *  generated/vendored when its average line length exceeds ~110 chars, and the
 *  added side of the patch is the best proxy we have. Returns 0 when there's no
 *  added content to judge. */
function avgAddedLineLength(patch: string): number {
  let total = 0;
  let count = 0;
  for (const line of patch.split("\n")) {
    // `+` content only — skip the `+++` file header and the `---`/`@@`/`diff` lines.
    if (line[0] !== "+" || line.startsWith("+++")) continue;
    total += line.length - 1; // drop the leading '+'
    count++;
  }
  return count === 0 ? 0 : total / count;
}

// Above this many changed lines a textual diff is "large" and collapsed by default
// (GitHub's "Large diffs are not rendered by default"). Set high so ordinary files
// stay open — only genuinely huge churn folds.
const LARGE_DIFF_LINES = 2000;
// A minified/packed file's added lines average longer than this.
const MINIFIED_AVG_LINE = 110;

export type FileForClassify = {
  filename: string;
  additions?: number;
  deletions?: number;
  /** The unified patch (used for the minified + large-diff heuristics). */
  patch?: string;
};

/** Decide whether a file collapses by default, and why. `attrs`, when given, is the
 *  repo's parsed .gitattributes — an explicit `linguist-generated`/`linguist-vendored`
 *  there wins over (or vetoes) every built-in rule, exactly as on GitHub. */
export function classifyFile(file: FileForClassify, attrs: LinguistRule[] = []): Classification {
  const path = file.filename;
  const name = basename(path).toLowerCase();

  // 1. .gitattributes is authoritative — including an explicit opt-OUT, which must
  //    override the built-in name rules (a repo can un-mark its own lockfile).
  const attr = gitattributesVerdict(path, attrs);
  if (attr.generated === true || attr.vendored === true)
    return { generated: true, reason: "gitattributes" };
  if (attr.generated === false || attr.vendored === false)
    return { generated: false, reason: null };

  // 2. Name/path rules.
  if (LOCKFILES.has(name)) return { generated: true, reason: "lockfile" };
  const segments = path.split("/");
  if (segments.slice(0, -1).some((s) => VENDOR_DIRS.includes(s)))
    return { generated: true, reason: "vendored" };
  if (name.endsWith(".map")) return { generated: true, reason: "sourcemap" };
  if (/\.min\.(js|css|mjs|cjs)$/.test(name)) return { generated: true, reason: "minified" };
  if (GENERATED_SUFFIXES.some((s) => name.endsWith(s)))
    return { generated: true, reason: "generated" };

  // 3. Heuristics off the patch.
  const patch = file.patch ?? "";
  if (patch && avgAddedLineLength(patch) > MINIFIED_AVG_LINE)
    return { generated: true, reason: "minified" };
  const changed = (file.additions ?? 0) + (file.deletions ?? 0);
  if (changed > LARGE_DIFF_LINES) return { generated: true, reason: "large" };

  return { generated: false, reason: null };
}

// ---- .gitattributes (linguist-generated / linguist-vendored) ----------------
// A repo overrides linguist's guesses with .gitattributes lines like
// `*.lock linguist-generated` or `src/bundled/** linguist-vendored=false`. We parse
// just the two attributes we care about; the last matching line wins per attribute
// (git's own semantics).

export type LinguistRule = {
  pattern: string;
  /** true = set, false = explicitly unset (`-linguist-generated`/`=false`), undefined = untouched. */
  generated?: boolean;
  vendored?: boolean;
};

function attrValue(token: string): { key: string; value: boolean } | null {
  // `linguist-generated`, `linguist-generated=true|false`, `-linguist-generated`.
  if (token.startsWith("-")) return { key: token.slice(1), value: false };
  const eq = token.indexOf("=");
  if (eq === -1) return { key: token, value: true };
  const val = token.slice(eq + 1).toLowerCase();
  return { key: token.slice(0, eq), value: !(val === "false" || val === "0" || val === "no") };
}

/** Parse a .gitattributes file into the linguist-generated/vendored rules it sets.
 *  Lines touching neither attribute are dropped. */
export function parseGitattributes(text: string): LinguistRule[] {
  const rules: LinguistRule[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [pattern, ...tokens] = line.split(/\s+/);
    if (!pattern) continue;
    const rule: LinguistRule = { pattern };
    let touched = false;
    for (const token of tokens) {
      const parsed = attrValue(token);
      if (!parsed) continue;
      if (parsed.key === "linguist-generated") {
        rule.generated = parsed.value;
        touched = true;
      } else if (parsed.key === "linguist-vendored") {
        rule.vendored = parsed.value;
        touched = true;
      }
    }
    if (touched) rules.push(rule);
  }
  return rules;
}

/** Resolve a path against parsed .gitattributes rules — last match wins per
 *  attribute, matching git's own override order. */
export function gitattributesVerdict(
  path: string,
  rules: LinguistRule[],
): { generated?: boolean; vendored?: boolean } {
  const out: { generated?: boolean; vendored?: boolean } = {};
  for (const rule of rules) {
    if (!gitignoreMatch(path, rule.pattern)) continue;
    if (rule.generated !== undefined) out.generated = rule.generated;
    if (rule.vendored !== undefined) out.vendored = rule.vendored;
  }
  return out;
}

/** Gitignore/gitattributes-style glob match. A pattern with no slash matches the
 *  basename at any depth; otherwise it's anchored to the repo root. `*` stops at a
 *  `/`, `**` spans them, `?` is a single non-slash char. (A practical subset — enough
 *  for the `*.lock` / `dir/**` patterns that appear in real .gitattributes.) */
export function gitignoreMatch(path: string, pattern: string): boolean {
  let pat = pattern;
  if (pat.endsWith("/")) pat += "**"; // a dir pattern matches everything under it
  const anchored = pat.includes("/");
  const target = anchored ? path : basename(path);
  const re = globToRegExp(pat.startsWith("/") ? pat.slice(1) : pat);
  return re.test(target);
}

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++; // `**/` also matches zero dirs
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}
