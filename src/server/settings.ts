import { eq } from "drizzle-orm";
import { SyncMode } from "../shared/types.ts";
import { db } from "./db.ts";
import { settings } from "./schema.ts";

// Operator settings, persisted in the single-row `settings` table so a toggle
// survives a restart. Both the watcher (`autoRebase`, per PR per tick) and autosync
// (`syncMode`, on every write) read on hot paths, so we keep an in-memory cache
// loaded once at boot and updated on every write — reads stay synchronous, writes go
// through to the DB.

const SINGLETON_ID = 1;

export type SettingsCache = {
  autoRebase: boolean;
  syncMode: SyncMode;
  syncBranch: string;
};

let cache: SettingsCache = {
  autoRebase: true,
  syncMode: SyncMode.Off,
  syncBranch: "powdermonkey-backup",
};

/** Load persisted settings into the cache at boot, creating the row on first run. */
export async function loadSettings(): Promise<void> {
  const rows = await db.select().from(settings).where(eq(settings.id, SINGLETON_ID));
  if (rows[0]) {
    cache = {
      autoRebase: rows[0].autoRebase,
      syncMode: rows[0].syncMode,
      syncBranch: rows[0].syncBranch,
    };
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
