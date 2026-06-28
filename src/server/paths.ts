import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Where the *code* lives, as opposed to where the operator's *project* lives.
//
// PowderMonkey is meant to be installed globally (`npm i -g powdermonkey`, or a
// prebuilt binary) and run from inside whatever project it's supervising. That
// splits "here" into two:
//
//   - The PROJECT dir — the operator's cwd. Mutable state belongs here: the PGlite
//     store (data/pgdata), uploads, the git worktrees. Already cwd-relative, stays so.
//   - The ASSET dir — wherever PowderMonkey itself was unpacked. Code-bundled,
//     read-only assets belong here: the built web UI and the Drizzle migrations.
//     These must NOT be resolved against the cwd, or a global install serving a
//     foreign project would look for them in that project and miss.
//
// Two run modes:
//   - dev / `npm i -g` — TypeScript run by bun. import.meta.url resolves to this
//     file's real path (symlink-proof), so the assets sit two levels up from it.
//   - compiled binary (`bun build --compile`) — the module graph is served from
//     bun's in-memory filesystem, so import.meta.url lives under it and CANNOT be
//     read off disk by path. The assets ship *beside* the executable instead, so
//     resolve them relative to the binary (process.execPath).
export const IS_COMPILED = import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN");

const ASSET_ROOT = IS_COMPILED
  ? dirname(process.execPath)
  : fileURLToPath(new URL("../..", import.meta.url));

/** The built web bundle (index.html + assets/), produced by `bun run build:web`. */
export const PUBLIC_DIR = join(ASSET_ROOT, "public");

/** The Drizzle migrations folder, applied at boot by db.ts. */
export const MIGRATIONS_DIR = join(ASSET_ROOT, "drizzle");

// PGlite's WASM module + Emscripten filesystem image. In dev PGlite finds these
// itself (in node_modules, via its own import.meta.url). In a compiled binary that
// lookup resolves into the virtual fs and the files aren't there, so we ship them
// beside the executable and hand them to PGlite explicitly (see db.ts).
export const PG_WASM = join(ASSET_ROOT, "postgres.wasm");
export const PG_DATA = join(ASSET_ROOT, "postgres.data");

// The CLI entry, used only in dev to re-invoke ourselves (the supervisor restart
// loop spawns a fresh server process). In a compiled binary we re-exec the binary
// directly, so this disk path is never consulted there.
const BIN_ENTRY = fileURLToPath(new URL("../../bin/powdermonkey.ts", import.meta.url));

/** argv that re-runs THIS program with the given args: the compiled executable
 *  directly, or `bun <cli> …` under a dev/npm install. This is what lets the
 *  supervisor spawn itself without assuming `bun` is on PATH once it ships as a
 *  standalone binary — the binary is its own runtime. */
export function selfArgv(...args: string[]): string[] {
  return IS_COMPILED ? [process.execPath, ...args] : [process.execPath, BIN_ENTRY, ...args];
}
