// Minimal load test for the `better-drizzle` npm package (v0.1.0).
// Goal: just import the module and see whether it loads.
//
// Run:  bun run index.ts
//
// Result: it CRASHES on load. The published ESM build (dist/index.js, the
// default `import` entry) has an `export { z as version, p as better, ... }`
// statement that references identifiers which are never declared in the file.
// The core `better()` factory and `version` are missing from the ESM bundle.
//
//   bun:  error: "z" is not declared in this file / "p" is not declared...
//   node: SyntaxError: Export 'p' is not defined in module
//
// The CJS build (dist/index.cjs, used by `require`) loads fine.
import * as bd from "better-drizzle";

console.log("better-drizzle loaded OK");
console.log("exports:", Object.keys(bd).sort());
