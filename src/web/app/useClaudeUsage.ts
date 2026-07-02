import { useEffect, useState } from "react";
import type { ClaudeUsage } from "../../server/claude-usage.ts";
import { api } from "../client.ts";

// Claude usage/limits for the status bar. Unlike the plan tables this isn't a synced
// collection (it's an external reading, not our DB), so the bar polls the endpoint on
// an interval. The server caches for 60s and serves stale-on-error, so a tight poll
// here is cheap and the reading never flickers to blank on a transient blip.
const POLL_MS = 60_000;

/** Poll `GET /claude/usage`, returning the latest reading (or null until the first
 *  response lands). Refreshes every POLL_MS and on remount; failures leave the last
 *  good value in place rather than blanking it. */
export function useClaudeUsage(): ClaudeUsage | null {
  const [usage, setUsage] = useState<ClaudeUsage | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const { data } = await api.claude.usage.get();
      if (!cancelled && data) setUsage(data as ClaudeUsage);
    };
    load();
    const id = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return usage;
}
