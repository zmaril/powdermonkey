#!/usr/bin/env bun
// Install PowderMonkey's git hooks.
//
// Default: point core.hooksPath at the checked-in `hooks/` directory. The path is
// stored *relative* (`hooks`), so each git worktree resolves it against its own
// checkout and runs its own copy of the hooks — which is exactly what makes it
// safe across the pm/task-* worktrees the supervisor cuts. It's idempotent:
// re-running just re-asserts the config and the executable bits, so a fresh clone
// (or `bun install`) can always run `bun run hooks:install` again with no harm.
//
// Flags:
//   --copy       write the hooks into .git/hooks instead of using core.hooksPath
//                (for a setup that can't use hooksPath). Shared .git/hooks lives in
//                the common git dir, so this is worktree-safe too.
//   --uninstall  undo whichever install is in place.
//
// Usage:  bun run hooks:install   (alias for `bun run scripts/install-hooks.ts`)

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";

const MARKER = "PowderMonkey managed hook";
const HOOK_NAMES = ["pre-commit", "pre-push"];
const HELPERS = ["lib.sh"];
const HOOKS_PATH_VALUE = "hooks"; // relative — resolved per-worktree by git

function git(...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args]);
  if (r.exitCode !== 0) {
    const err = new TextDecoder().decode(r.stderr).trim();
    throw new Error(`git ${args.join(" ")} failed: ${err}`);
  }
  return new TextDecoder().decode(r.stdout).trim();
}

/** `git config --get`, returning "" when the key is unset (exit 1 is not an error here). */
function gitConfigGet(key: string): string {
  const r = Bun.spawnSync(["git", "config", "--local", "--get", key]);
  return r.exitCode === 0 ? new TextDecoder().decode(r.stdout).trim() : "";
}

const repoRoot = git("rev-parse", "--show-toplevel");
const sourceDir = join(repoRoot, "hooks");
// The real hooks dir in the shared (common) git dir — where --copy writes and
// --uninstall cleans, regardless of which worktree we're run from.
const commonGitDir = git("rev-parse", "--git-common-dir");
const gitHooksDir = join(commonGitDir.startsWith("/") ? commonGitDir : join(repoRoot, commonGitDir), "hooks");

const mode = process.argv.slice(2);
const uninstall = mode.includes("--uninstall");
const copy = mode.includes("--copy");

function ensureExecutable(dir: string): void {
  for (const name of HOOK_NAMES) chmodSync(join(dir, name), 0o755);
}

/** Does a file exist and carry our ownership marker? Guards --uninstall so we
 *  never delete a hook the user wrote by hand. */
function isOurs(path: string): boolean {
  return existsSync(path) && readFileSync(path, "utf8").includes(MARKER);
}

function installHooksPath(): void {
  const current = gitConfigGet("core.hooksPath");
  if (current && current !== HOOKS_PATH_VALUE) {
    console.log(`↻ core.hooksPath was "${current}" — repointing it at "${HOOKS_PATH_VALUE}/".`);
  }
  git("config", "core.hooksPath", HOOKS_PATH_VALUE);
  ensureExecutable(sourceDir);
  console.log(`✓ git hooks installed via core.hooksPath → ${HOOKS_PATH_VALUE}/ (${HOOK_NAMES.join(", ")}).`);
  console.log("  Each worktree runs its own checked-in hooks. Bypass once with --no-verify.");
}

function installCopy(): void {
  // core.hooksPath would shadow .git/hooks, so clear it when copying.
  if (gitConfigGet("core.hooksPath")) git("config", "--unset", "core.hooksPath");
  mkdirSync(gitHooksDir, { recursive: true });
  for (const name of [...HOOK_NAMES, ...HELPERS]) {
    copyFileSync(join(sourceDir, name), join(gitHooksDir, name));
  }
  ensureExecutable(gitHooksDir);
  console.log(`✓ git hooks copied into ${gitHooksDir} (${HOOK_NAMES.join(", ")}).`);
  console.log("  Re-run after changing a hook to refresh the copy. Bypass once with --no-verify.");
}

function doUninstall(): void {
  let did = false;
  if (gitConfigGet("core.hooksPath") === HOOKS_PATH_VALUE) {
    git("config", "--unset", "core.hooksPath");
    console.log("✓ removed core.hooksPath.");
    did = true;
  }
  for (const name of [...HOOK_NAMES, ...HELPERS]) {
    const path = join(gitHooksDir, name);
    if (isOurs(path) || (HELPERS.includes(basename(path)) && existsSync(path) && wasCopied())) {
      rmSync(path);
      console.log(`✓ removed ${path}`);
      did = true;
    }
  }
  if (!did) console.log("Nothing to uninstall — no PowderMonkey hooks were installed.");
}

/** True when our copied hooks are present in .git/hooks (so their lib.sh is ours too). */
function wasCopied(): boolean {
  return HOOK_NAMES.some((name) => isOurs(join(gitHooksDir, name)));
}

if (uninstall) doUninstall();
else if (copy) installCopy();
else installHooksPath();
