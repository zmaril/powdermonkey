import { fileURLToPath } from "node:url";

// Where the *code* lives, as opposed to where the operator's *project* lives.
//
// PowderMonkey is meant to be installed globally (`npm i -g powdermonkey`) and run
// from inside whatever project it's supervising. That splits "here" into two:
//
//   - The PROJECT dir — the operator's cwd. Mutable state belongs here: the PGlite
//     store (data/pgdata), uploads, the git worktrees. Already cwd-relative, stays so.
//   - The PACKAGE dir — wherever npm unpacked us (node_modules/powdermonkey, or the
//     repo in dev). Code-bundled, read-only assets belong here: the built web UI and
//     the Drizzle migrations. Those must NOT be resolved against the cwd, or a global
//     install serving a foreign project would look for them in that project and miss.
//
// import.meta.url resolves to this file's real location even when the bin is a
// symlink on PATH, so deriving the package root from it is robust where a
// $0/cwd-relative path would break. This module is two levels below the root
// (src/server/paths.ts), hence "../..".
export const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** The built web bundle (index.html + assets/), produced by `bun run build:web`. */
export const PUBLIC_DIR = fileURLToPath(new URL("../../public", import.meta.url));

/** The Drizzle migrations folder, applied at boot by db.ts. */
export const MIGRATIONS_DIR = fileURLToPath(new URL("../../drizzle", import.meta.url));
