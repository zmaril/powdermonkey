import { eq } from "drizzle-orm";
import { DispatchBackend } from "../shared/types.ts";
import { db } from "./db.ts";
import { type Settings, settings } from "./schema.ts";

// Operator settings, persisted in the single-row `settings` table so a toggle
// survives a restart. Hot paths read these synchronously (the watcher reads
// `autoRebase` per PR/tick; dispatch reads the backend + exe.dev config per launch),
// so we keep an in-memory cache loaded once at boot and updated on every write — the
// read stays synchronous, the write goes through to the DB.

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
type Cache = {
  autoRebase: boolean;
  dispatchBackend: DispatchBackend;
  exeTemplate: string;
  exeTtydPort: number;
  exeClaudeFlags: string;
  exeAutoTeardown: boolean;
};

let cache: Cache = {
  autoRebase: true,
  dispatchBackend: DispatchBackend.ExeDev,
  exeTemplate: "powdermonkey",
  exeTtydPort: 3456,
  exeClaudeFlags: "--dangerously-skip-permissions",
  exeAutoTeardown: true,
};

function seed(row: Settings): void {
  cache = {
    autoRebase: row.autoRebase,
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
