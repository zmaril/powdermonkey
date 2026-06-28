import { eq } from "drizzle-orm";
import { db } from "./db.ts";
import { settings } from "./schema.ts";

// Operator settings, persisted in the single-row `settings` table so a toggle
// survives a restart. The watcher reads `autoRebase` on the hot path (per PR, per
// tick), so we keep an in-memory cache that's loaded once at boot and updated on
// every write — the read stays synchronous, the write goes through to the DB.

const SINGLETON_ID = 1;
let cache = { autoRebase: true };

/** Load persisted settings into the cache at boot, creating the row on first run. */
export async function loadSettings(): Promise<void> {
  const rows = await db.select().from(settings).where(eq(settings.id, SINGLETON_ID));
  if (rows[0]) {
    cache = { autoRebase: rows[0].autoRebase };
  } else {
    await db.insert(settings).values({ id: SINGLETON_ID }).onConflictDoNothing();
  }
}

/** Whether the watcher should auto-ask @claude to rebase a conflicting PR. */
export function getAutoRebase(): boolean {
  return cache.autoRebase;
}

/** Flip the auto-rebase toggle: update the cache and persist it. */
export async function setAutoRebase(on: boolean): Promise<void> {
  cache.autoRebase = on;
  await db
    .insert(settings)
    .values({ id: SINGLETON_ID, autoRebase: on, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.id, set: { autoRebase: on, updatedAt: new Date() } });
}
