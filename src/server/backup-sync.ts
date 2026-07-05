// Data durability: turning the live store into a snapshot and getting that snapshot
// somewhere durable — on demand (export to a branch/PR) and continuously (autosync).
//
// Two write paths, one primitive. Both dump the store to a logical JSON snapshot
// (backup.ts) and commit it to a branch straight from the git object store
// (git.commitFileToBranch) — never touching the operator's working tree. What differs
// is *where* and *when*:
//   • Export (on demand)  — a fresh branch, optionally opened as a PR. One per call.
//   • Autosync (on write) — ONE durable branch, appended to on every change, debounced
//     and batched, off the write hot path, optionally pushed to origin.
//
// The read/import side lives in backup-source.ts (DB-free, for the restore CLI).

import { getTableName } from "drizzle-orm";
import { SyncMode } from "../shared/types.ts";
import { dumpSnapshot, type Snapshot, type SqlClient, snapshotDataJson } from "./backup.ts";
import { SNAPSHOT_FILE } from "./backup-source.ts";
import { pg } from "./db.ts";
import { gh, resolveRepo } from "./gh.ts";
import { commitFileToBranch, fetchBranch, pushBranch, revParse } from "./git.ts";
import {
  goals,
  milestones,
  notes,
  phases,
  proposals,
  pullRequests,
  repos,
  sessions,
  sessionTasks,
  settings,
  taskComments,
  tasks,
} from "./schema.ts";
import { getSyncBranch, getSyncMode } from "./settings.ts";

// The tables autosync watches for writes. Same set the browser mirrors over /sync
// (app.ts SYNC_TABLES) plus `settings`, so *every* store write schedules a snapshot.
const WATCHED_TABLES: string[] = [
  goals,
  milestones,
  tasks,
  phases,
  sessions,
  sessionTasks,
  taskComments,
  notes,
  repos,
  pullRequests,
  proposals,
  settings,
  // biome-ignore lint/suspicious/noExplicitAny: introspected generically.
].map((t: any) => getTableName(t));

/** Dump the current store to a snapshot, stamped now. */
export async function currentSnapshot(): Promise<Snapshot> {
  return dumpSnapshot(pg as unknown as SqlClient, new Date().toISOString());
}

/** Serialize a snapshot for storage — pretty JSON so it diffs cleanly in git. */
export function serializeSnapshot(snap: Snapshot): string {
  return `${JSON.stringify(snap, null, 2)}\n`;
}

function rowCount(snap: Snapshot): number {
  return Object.values(snap.data).reduce((n, rows) => n + rows.length, 0);
}

function commitMessage(snap: Snapshot): string {
  return `powdermonkey snapshot ${snap.meta.takenAt} (${rowCount(snap)} rows, v${snap.meta.pmVersion})`;
}

// ---- on-demand export ------------------------------------------------------

export type ExportResult = { branch: string; sha: string; rows: number; pushed: boolean };

/** Commit the current snapshot to `branch` from the object store. Optionally chains
 *  onto the remote tip and pushes (so `push` re-runs are appends, not clobbers). */
export async function exportSnapshotToBranch(
  branch: string,
  opts: { push?: boolean } = {},
): Promise<ExportResult> {
  const snap = await currentSnapshot();
  const parentRef = opts.push ? await remoteParent(branch) : undefined;
  const res = await commitFileToBranch({
    branch,
    fileName: SNAPSHOT_FILE,
    content: serializeSnapshot(snap),
    message: commitMessage(snap),
    parentRef,
  });
  if (!res.ok) throw new Error(res.error);
  let pushed = false;
  if (opts.push) {
    const p = await pushBranch(branch);
    if (!p.ok) throw new Error(`push failed: ${p.output}`);
    pushed = true;
  }
  return { branch, sha: res.sha, rows: rowCount(snap), pushed };
}

export type PrExportResult = ExportResult & { prUrl: string | null };

/** Export the current snapshot as a PR: commit it to a fresh branch, push, open a PR.
 *  Unlike autosync (one durable branch), each call is its own branch + PR — a
 *  point-in-time archive the operator can review and merge, or leave as a durable ref. */
export async function exportSnapshotToPr(
  opts: { branch?: string; base?: string; title?: string; body?: string } = {},
): Promise<PrExportResult> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const branch = opts.branch ?? `powdermonkey-backup-${stamp}`;
  const exported = await exportSnapshotToBranch(branch, { push: true });
  const base = opts.base ?? "main";
  const title = opts.title ?? `PowderMonkey backup — ${exported.rows} rows`;
  const body =
    opts.body ??
    `Logical snapshot of the PowderMonkey store (${exported.rows} rows).\n\n` +
      `Restore with:\n\n\`\`\`sh\npowdermonkey restore --pr <this-pr-number>\n\`\`\`\n`;
  const repo = await resolveRepo();
  const args = ["pr", "create", "--head", branch, "--base", base, "--title", title, "--body", body]; // lint-allow-string: gh subcommand, not ProposalOp.Create
  if (repo) args.push("--repo", `${repo.owner}/${repo.name}`);
  const r = await gh(args);
  // The branch is pushed regardless; a failed `pr create` (e.g. no gh auth) still
  // leaves a durable branch, so surface the branch and a null prUrl rather than throw.
  const prUrl = r.ok ? r.stdout.trim() || null : null;
  return { ...exported, prUrl };
}

/** Resolve the remote tip of `branch` to chain onto (so a push fast-forwards). Fetch
 *  first; return `origin/<branch>` if it now exists, else undefined (fresh branch). */
async function remoteParent(branch: string): Promise<string | undefined> {
  await fetchBranch(branch);
  return (await revParse(`origin/${branch}`)) ? `origin/${branch}` : undefined;
}

// ---- autosync engine -------------------------------------------------------

/** How long a burst of writes is coalesced before a snapshot is produced. Tunable so
 *  the round-trip/e2e tests don't wait seconds. */
const DEBOUNCE_MS = Number(process.env.PM_AUTOSYNC_DEBOUNCE_MS ?? 2000);

export type SyncStatus = {
  mode: SyncMode;
  branch: string;
  /** ISO time of the last successful sync (or the last no-op skip), null if never. */
  lastSyncedAt: string | null;
  /** The commit sha the last sync produced, null if the last run was a no-op/failed. */
  lastCommit: string | null;
  /** Whether the last successful sync pushed to origin. */
  pushed: boolean;
  /** Rows in the last snapshot, null until the first sync. */
  rows: number | null;
  /** The last error message, cleared on the next success. Null when healthy. */
  lastError: string | null;
  /** A sync is running right now. */
  syncing: boolean;
  /** A change is queued (dirty) and waiting for the debounce/next run. */
  pending: boolean;
};

const status: SyncStatus = {
  mode: SyncMode.Off,
  branch: "powdermonkey-backup",
  lastSyncedAt: null,
  lastCommit: null,
  pushed: false,
  rows: null,
  lastError: null,
  syncing: false,
  pending: false,
};

// The data JSON of the last committed snapshot — so an autosync fire that finds
// nothing actually changed (a no-op UPDATE, an archived row the live feed still
// reports) skips the commit instead of piling up identical snapshots.
let lastSyncedDataJson: string | null = null;

let dirty = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;

/** The live-synced view of autosync for the UI / `GET /backup/status`. `mode` and
 *  `branch` are read live from settings so the panel reflects a just-flipped toggle. */
export function syncStatus(): SyncStatus {
  return { ...status, mode: getSyncMode(), branch: getSyncBranch(), pending: dirty };
}

/** Mark the store dirty and arm the debounce timer. Called from the live-changes
 *  callback — cheap and synchronous, so it NEVER blocks the write that triggered it.
 *  The actual snapshot + git work happens later, on the timer. */
function scheduleSync(): void {
  dirty = true;
  if (timer || status.syncing) return; // a run is already armed or in flight
  timer = setTimeout(runSync, DEBOUNCE_MS);
}

async function runSync(): Promise<void> {
  timer = null;
  if (getSyncMode() === SyncMode.Off) {
    dirty = false; // off: drop the queue rather than snapshotting into the void
    return;
  }
  if (!dirty) return;
  dirty = false;
  status.syncing = true;
  try {
    await syncNow();
    status.lastError = null;
  } catch (e) {
    status.lastError = e instanceof Error ? e.message : String(e);
    console.warn("autosync failed:", status.lastError);
  } finally {
    status.syncing = false;
    // Changes that landed mid-sync (dirty flipped back true) get their own run.
    if (dirty && getSyncMode() !== SyncMode.Off) timer = setTimeout(runSync, DEBOUNCE_MS);
  }
}

/** Produce the current snapshot and land it on the durable branch per the mode.
 *  Skips the commit when nothing changed since the last sync (no empty commits). */
export async function syncNow(): Promise<void> {
  const mode = getSyncMode();
  if (mode === SyncMode.Off) return;
  const branch = getSyncBranch();
  const snap = await currentSnapshot();
  const dataJson = snapshotDataJson(snap);
  if (dataJson === lastSyncedDataJson) {
    // Nothing actually changed — record the heartbeat, skip the commit.
    status.lastSyncedAt = snap.meta.takenAt;
    return;
  }
  const push = mode === SyncMode.Push;
  const parentRef = push ? await remoteParent(branch) : undefined;
  const res = await commitFileToBranch({
    branch,
    fileName: SNAPSHOT_FILE,
    content: serializeSnapshot(snap),
    message: commitMessage(snap),
    parentRef,
  });
  if (!res.ok) throw new Error(res.error);
  if (push) {
    const p = await pushBranch(branch);
    if (!p.ok) throw new Error(`push failed: ${p.output}`);
  }
  lastSyncedDataJson = dataJson;
  status.lastSyncedAt = snap.meta.takenAt;
  status.lastCommit = res.sha;
  status.pushed = push;
  status.rows = rowCount(snap);
}

/** Subscribe to the live-changes feed on every watched table and wire each change to
 *  the debounced sync. Idempotent; call once at boot (index.ts). `subscribe` fires only
 *  on change *deltas* (the boot snapshot rides on `lc.initialChanges`, which we don't
 *  register a query for), so every callback here is a real write worth snapshotting. */
export function startAutosync(): void {
  if (started) return;
  started = true;
  for (const table of WATCHED_TABLES) {
    pg.live
      .changes(`SELECT * FROM "${table}"`, [], primaryKeyGuess(table))
      .then((lc) => lc.subscribe(() => scheduleSync()))
      .catch((e) => console.warn(`autosync: couldn't watch ${table}:`, e));
  }
}

/** The two tables that don't key on `id`. `live.changes` needs a stable key column. */
function primaryKeyGuess(table: string): string {
  if (table === "pull_requests") return "number";
  return "id";
}

/** Kick a sync now if autosync is on — used when the operator flips the mode on, so
 *  the durable branch is seeded immediately rather than waiting for the next write. */
export function triggerSyncSoon(): void {
  if (getSyncMode() !== SyncMode.Off) scheduleSync();
}
