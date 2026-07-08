import type { BackendUsage } from "../../server/disponent-usage.ts";
import { api } from "../client.ts";
import { usePolled } from "../usePolled.ts";

// Per-backend usage/cost meters for the status bar. Like Claude usage this isn't a
// synced collection — it's rolled up from disponent's event stream on the server —
// so the bar polls the endpoint on an interval (usePolled). Cheap: the meters
// accumulate on the server's own poll loop, so this just reads the latest totals.
const POLL_MS = 60_000;

const fetchBackends = async (): Promise<BackendUsage[] | null> => {
  const { data } = await api.backends.usage.get();
  return (data as { backends: BackendUsage[] } | null)?.backends ?? null;
};

/** Poll `GET /backends/usage`, returning the per-backend rollup (or null until the
 *  first response). Refreshes every POLL_MS and on remount; a failed fetch leaves
 *  the last good value in place rather than blanking it. */
export function useBackendUsage(): BackendUsage[] | null {
  return usePolled(fetchBackends, POLL_MS);
}
