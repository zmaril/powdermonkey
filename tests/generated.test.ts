import { expect, test } from "bun:test";
import { classifyFile, gitignoreMatch, parseGitattributes } from "../src/server/generated.ts";

// The ruleset behind auto-collapsing generated/vendored files in the review pane.
// These pin the conditions GitHub uses (lockfiles, vendored dirs, minified, source
// maps, .gitattributes overrides, large diffs) so a future tweak can't silently
// start hiding hand-written code — or stop hiding bun.lock.

test("lockfiles collapse, case-insensitively", () => {
  for (const f of ["bun.lock", "package-lock.json", "yarn.lock", "Cargo.lock", "Gemfile.lock"]) {
    expect(classifyFile({ filename: f })).toEqual({ generated: true, reason: "lockfile" });
  }
  // Nested path still matches on basename.
  expect(classifyFile({ filename: "packages/app/pnpm-lock.yaml" }).reason).toBe("lockfile");
});

test("vendored directories collapse", () => {
  expect(classifyFile({ filename: "node_modules/left-pad/index.js" }).reason).toBe("vendored");
  expect(classifyFile({ filename: "vendor/github.com/foo/bar.go" }).reason).toBe("vendored");
  // The segment must be a real path component, not a substring of a name.
  expect(classifyFile({ filename: "src/vendored-helpers.ts" }).generated).toBe(false);
});

test("minified, source maps, and generated suffixes collapse", () => {
  expect(classifyFile({ filename: "public/app.min.js" }).reason).toBe("minified");
  expect(classifyFile({ filename: "public/app.js.map" }).reason).toBe("sourcemap");
  expect(classifyFile({ filename: "api/service.pb.go" }).reason).toBe("generated");
});

test("a packed bundle is caught by line-length even without a .min name", () => {
  const longLine = "+".concat("a=1;".repeat(400)); // one ~1600-char added line
  expect(classifyFile({ filename: "public/assets/main.js", patch: longLine }).reason).toBe(
    "minified",
  );
});

test("ordinary source files stay open", () => {
  const patch = "@@ -1,2 +1,3 @@\n const x = 1;\n+const y = 2;\n const z = 3;";
  expect(classifyFile({ filename: "src/web/ReviewPane.tsx", patch, additions: 1 })).toEqual({
    generated: false,
    reason: null,
  });
});

test("a very large textual diff collapses", () => {
  expect(classifyFile({ filename: "src/data.ts", additions: 1500, deletions: 700 }).reason).toBe(
    "large",
  );
});

test(".gitattributes linguist-generated forces collapse, =false vetoes a built-in rule", () => {
  const rules = parseGitattributes(
    ["src/schema.gen.ts linguist-generated", "bun.lock linguist-generated=false"].join("\n"),
  );
  expect(classifyFile({ filename: "src/schema.gen.ts" }, rules).reason).toBe("gitattributes");
  // The repo un-marked its own lockfile → it should NOT collapse.
  expect(classifyFile({ filename: "bun.lock" }, rules).generated).toBe(false);
});

test("parseGitattributes reads linguist-vendored and negation", () => {
  const rules = parseGitattributes(
    ["dist/** linguist-vendored", "-src/keep.js linguist-generated", "*.txt text"].join("\n"),
  );
  // The `*.txt text` line touches neither attribute → dropped.
  expect(rules.find((r) => r.pattern === "*.txt")).toBeUndefined();
  expect(classifyFile({ filename: "dist/bundle.js" }, rules).reason).toBe("gitattributes");
});

test("gitignoreMatch: basename vs anchored vs ** patterns", () => {
  expect(gitignoreMatch("a/b/c.lock", "*.lock")).toBe(true); // no slash → basename anywhere
  expect(gitignoreMatch("dist/x/y.js", "dist/**")).toBe(true);
  expect(gitignoreMatch("src/dist/y.js", "dist/**")).toBe(false); // anchored to root
  expect(gitignoreMatch("vendor/lib.go", "vendor/")).toBe(true); // trailing slash → tree
  expect(gitignoreMatch("a/deep/file.js", "**/file.js")).toBe(true);
});
