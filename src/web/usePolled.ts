import { useEffect, useState } from "react";

// The shared poll-with-cleanup skeleton for the few server readings that AREN'T synced
// collections (Claude usage, autosync status) — external state we read on an interval
// rather than stream over /sync. Keeping it in one place means each such hook is just
// "poll this endpoint every N ms", and there's one definition of the mount/cleanup dance.

/** Call `fetch` on mount and every `ms`, returning the latest non-null value (or null
 *  until the first response). A failed/blank fetch leaves the last good value in place
 *  rather than blanking it. `fetch` must be stable (define it at module scope), since
 *  it's an effect dependency. */
export function usePolled<T>(fetch: () => Promise<T | null>, ms: number): T | null {
  const [value, setValue] = useState<T | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const v = await fetch();
      if (!cancelled && v) setValue(v);
    };
    load();
    const id = setInterval(load, ms);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [fetch, ms]);

  return value;
}
