// Reading a snapshot back out of an export — a local file, a git branch, or a PR.
// The counterpart to the export/autosync write side (backup-sync.ts), kept separate
// and DB-free on purpose: `powdermonkey restore` reads a snapshot from a branch/PR
// *before* it opens the store (opening the store takes the writer lock, and restore
// must have the source in hand first). So this module leans only on git.ts / gh.ts,
// never on db.ts.

import { readFileSync } from "node:fs";
import type { Snapshot } from "./backup.ts";
import { gh } from "./gh.ts";
import { fetchBranch, showFile } from "./git.ts";

/** The filename a snapshot lives under on a sync/export branch. */
export const SNAPSHOT_FILE = "snapshot.json";

/** Parse + shape-check snapshot JSON. Throws a clear error rather than letting a
 *  malformed file blow up deep inside restore. */
export function parseSnapshot(json: string): Snapshot {
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch (e) {
    throw new Error(`not valid JSON: ${e instanceof Error ? e.message : e}`);
  }
  const snap = obj as Snapshot;
  if (!snap || typeof snap !== "object" || !snap.data || typeof snap.data !== "object") {
    throw new Error("not a PowderMonkey snapshot (missing a `data` object)");
  }
  return snap;
}

/** Read a snapshot from a local file. */
export function readSnapshotFromFile(path: string): Snapshot {
  return parseSnapshot(readFileSync(path, "utf8"));
}

/** Read a snapshot straight out of a branch, without a checkout: fetch it, then
 *  `git show <ref>:snapshot.json`. Prefers the freshly-fetched remote tip, falling
 *  back to a local branch of the same name (so it also works fully offline against a
 *  branch autosync committed locally). */
export async function readSnapshotFromBranch(opts: {
  branch: string;
  file?: string;
  cwd?: string;
}): Promise<Snapshot> {
  const file = opts.file ?? SNAPSHOT_FILE;
  await fetchBranch(opts.branch, opts.cwd); // best-effort; a local-only branch still resolves below
  for (const ref of [`origin/${opts.branch}`, opts.branch]) {
    const r = await showFile(ref, file, opts.cwd);
    if (r.ok) return parseSnapshot(r.output);
  }
  throw new Error(
    `no ${file} on branch "${opts.branch}" (looked at origin/${opts.branch} and ${opts.branch})`,
  );
}

/** Read a snapshot from a PR: resolve its head branch via `gh`, then read the branch. */
export async function readSnapshotFromPr(
  prNumber: number,
  opts?: { file?: string; cwd?: string },
): Promise<Snapshot> {
  const r = await gh([
    "pr",
    "view",
    String(prNumber),
    "--json",
    "headRefName",
    "-q",
    ".headRefName",
  ]);
  if (!r.ok || !r.stdout.trim()) {
    throw new Error(`couldn't resolve PR #${prNumber}'s branch via gh: ${r.stderr || "no output"}`);
  }
  return readSnapshotFromBranch({ branch: r.stdout.trim(), ...opts });
}
