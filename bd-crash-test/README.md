# better-drizzle crash-on-load test

Reproduction for a load-time crash in [`better-drizzle`](https://www.npmjs.com/package/better-drizzle) **v0.1.0**.

## TL;DR

Importing the package as **ESM** (its default entry) crashes immediately on load,
under both Bun and Node. The **CJS** build loads fine.

## Setup

```bash
bun install
```

## Reproduce

```bash
bun run index.ts        # ESM import -> CRASH
bun run load-esm.mjs    # ESM import -> CRASH
node load-esm.mjs       # ESM import -> CRASH (SyntaxError at compile time)
bun run load-cjs.cjs    # CJS require -> OK
node load-cjs.cjs       # CJS require -> OK
```

## What happens

```
# bun
error: "z" is not declared in this file
error: "p" is not declared in this file
  at node_modules/better-drizzle/dist/index.js

# node
SyntaxError: Export 'p' is not defined in module
```

## Root cause

`better-drizzle`'s `package.json` is `"type": "module"` and its `exports` map
points `import` at `dist/index.js`. That ESM bundle ends with:

```js
export{z as version,k as isUniqueViolation,...,h as definePlugin,p as better,...};
```

but the local identifiers `z` (`version`) and `p` (`better`) — i.e. the package's
core `better()` factory and `version` constant — are **never declared anywhere in
the file**. They appear to have been dropped from the ESM bundle (they live in a
shared chunk that the ESM build fails to include), while the export list still
references them.

- Node rejects it statically at compile time (`Export 'p' is not defined in module`).
- Bun rejects it as undeclared identifiers on load.

The CJS build (`dist/index.cjs`) is complete and loads/exports all 14 symbols
correctly, so anything using `require()` is unaffected — but any modern ESM
`import` (Bun, Node ESM, Vite/webpack/esbuild, etc.) crashes on load.

This is a packaging/build bug in the published `0.1.0` artifact, not a usage error.
