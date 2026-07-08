import { eq } from "drizzle-orm";
import { DispatchBackend, SyncMode } from "../shared/types.ts";
import { db } from "./db.ts";
import { type Settings, settings } from "./schema.ts";

// Operator settings, persisted in the single-row `settings` table so a toggle
// survives a restart. Hot paths read these synchronously (the watcher reads
// `autoRebase` per PR/tick; autosync reads `syncMode` on every write; dispatch reads
// the backend + exe.dev config per launch), so we keep an in-memory cache loaded once
// at boot and updated on every write — reads stay synchronous, writes go through to
// the DB.

const SINGLETON_ID = 1;

/** The exe.dev worker config the dispatch backend reads (see src/server/exe-dev.ts). */
export type ExeDevConfig = {
  template: string;
  ttydPort: number;
  claudeFlags: string;
  autoTeardown: boolean;
};

// The mutable in-memory mirror of the singleton row. Defaults match the schema
// defaults so a read before `loadSettings` (or with no row yet) is still sane.
export type SettingsCache = {
  autoRebase: boolean;
  syncMode: SyncMode;
  syncBranch: string;
  dispatchBackend: DispatchBackend;
  exeTemplate: string;
  exeTtydPort: number;
  exeClaudeFlags: string;
  exeAutoTeardown: boolean;
};

let cache: SettingsCache = {
  autoRebase: true,
  syncMode: SyncMode.Off,
  syncBranch: "powdermonkey-backup",
  dispatchBackend: DispatchBackend.ExeDev,
  exeTemplate: "powdermonkey",
  exeTtydPort: 3456,
  exeClaudeFlags: "--dangerously-skip-permissions",
  exeAutoTeardown: true,
};

function seed(row: Settings): void {
  cache = {
    autoRebase: row.autoRebase,
    syncMode: row.syncMode,
    syncBranch: row.syncBranch,
    dispatchBackend: row.dispatchBackend,
    exeTemplate: row.exeTemplate,
    exeTtydPort: row.exeTtydPort,
    exeClaudeFlags: row.exeClaudeFlags,
    exeAutoTeardown: row.exeAutoTeardown,
  };
}

/** Load persisted settings into the cache at boot, creating the row on first run. */
export async function loadSettings(): Promise<void> {
  const rows = await db.select().from(settings).where(eq(settings.id, SINGLETON_ID));
  if (rows[0]) {
    seed(rows[0]);
  } else {
    await db.insert(settings).values({ id: SINGLETON_ID }).onConflictDoNothing();
  }
}

/** The whole settings snapshot (the /settings route serves this). */
export function getSettings(): SettingsCache {
  return { ...cache };
}

/** Whether the watcher should auto-ask @claude to rebase a conflicting PR. */
export function getAutoRebase(): boolean {
  return cache.autoRebase;
}

/** Flip the auto-rebase toggle: update the cache and persist it. */
export async function setAutoRebase(on: boolean): Promise<void> {
  await patchSettings({ autoRebase: on });
}

/** Autosync target (off / local / push) — read on the write hot path by autosync. */
export function getSyncMode(): SyncMode {
  return cache.syncMode;
}

/** The single durable branch snapshots land on. */
export function getSyncBranch(): string {
  return cache.syncBranch;
}

/** Update any subset of settings: patch the cache and persist. One writer, one row,
 *  so a partial update reads the current cache and rewrites the changed columns. */
export async function patchSettings(patch: Partial<SettingsCache>): Promise<SettingsCache> {
  cache = { ...cache, ...patch };
  await db
    .insert(settings)
    .values({ id: SINGLETON_ID, ...cache, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.id, set: { ...patch, updatedAt: new Date() } });
  return getSettings();
}

/** Which backend a "Dispatch remote" launch uses. Read synchronously at dispatch time. */
export function getDispatchBackend(): DispatchBackend {
  return cache.dispatchBackend;
}

/** The exe.dev worker config, read synchronously by the exe.dev dispatch/teardown paths. */
export function getExeDevConfig(): ExeDevConfig {
  return {
    template: cache.exeTemplate,
    ttydPort: cache.exeTtydPort,
    claudeFlags: cache.exeClaudeFlags,
    autoTeardown: cache.exeAutoTeardown,
  };
}

/** A partial update of the dispatch/exe.dev settings — only the provided keys change. */
export type DispatchSettings = {
  dispatchBackend?: DispatchBackend;
  exeTemplate?: string;
  exeTtydPort?: number;
  exeClaudeFlags?: string;
  exeAutoTeardown?: boolean;
};

/** The full dispatch/exe.dev settings snapshot (what the API returns to the UI). */
export function getDispatchSettings(): Required<DispatchSettings> {
  return {
    dispatchBackend: cache.dispatchBackend,
    exeTemplate: cache.exeTemplate,
    exeTtydPort: cache.exeTtydPort,
    exeClaudeFlags: cache.exeClaudeFlags,
    exeAutoTeardown: cache.exeAutoTeardown,
  };
}

/** Update the cache with the provided dispatch settings and persist them. Only the
 *  keys present in `next` change; the rest keep their current values. */
export async function setDispatchSettings(next: DispatchSettings): Promise<void> {
  if (next.dispatchBackend !== undefined) cache.dispatchBackend = next.dispatchBackend;
  if (next.exeTemplate !== undefined) cache.exeTemplate = next.exeTemplate;
  if (next.exeTtydPort !== undefined) cache.exeTtydPort = next.exeTtydPort;
  if (next.exeClaudeFlags !== undefined) cache.exeClaudeFlags = next.exeClaudeFlags;
  if (next.exeAutoTeardown !== undefined) cache.exeAutoTeardown = next.exeAutoTeardown;

  const set = {
    dispatchBackend: cache.dispatchBackend,
    exeTemplate: cache.exeTemplate,
    exeTtydPort: cache.exeTtydPort,
    exeClaudeFlags: cache.exeClaudeFlags,
    exeAutoTeardown: cache.exeAutoTeardown,
    updatedAt: new Date(),
  };
  await db
    .insert(settings)
    .values({ id: SINGLETON_ID, ...set })
    .onConflictDoUpdate({ target: settings.id, set });
}
