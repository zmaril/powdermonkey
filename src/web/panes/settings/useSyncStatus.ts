import { api } from "../../client.ts";
import { usePolled } from "../../usePolled.ts";

// Autosync status for the Settings pane. Like Claude usage, this is server runtime
// state rather than a synced collection, so the pane polls it (usePolled) on an
// interval; the last good value stays put on a transient blip.
const POLL_MS = 5000;

export type SyncStatus = {
  mode: string;
  branch: string;
  lastSyncedAt: string | null;
  lastCommit: string | null;
  pushed: boolean;
  rows: number | null;
  lastError: string | null;
  syncing: boolean;
  pending: boolean;
};

const fetchStatus = async (): Promise<SyncStatus | null> => {
  const { data } = await api.backup.status.get();
  return (data as SyncStatus) ?? null;
};

/** Poll `GET /backup/status`, returning the latest sync status (or null until the
 *  first response). */
export function useSyncStatus(): SyncStatus | null {
  return usePolled(fetchStatus, POLL_MS);
}
