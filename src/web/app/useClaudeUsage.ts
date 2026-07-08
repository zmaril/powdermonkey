import type { ClaudeUsage } from "../../server/claude-usage.ts";
import { api } from "../client.ts";
import { usePolled } from "../usePolled.ts";

// Claude usage/limits for the status bar. Unlike the plan tables this isn't a synced
// collection (it's an external reading, not our DB), so the bar polls the endpoint on
// an interval (usePolled). The server caches for 60s and serves stale-on-error, so a
// tight poll here is cheap and the reading never flickers to blank on a transient blip.
const POLL_MS = 60_000;

const fetchUsage = async (): Promise<ClaudeUsage | null> => {
  const { data } = await api.claude.usage.get();
  return (data as ClaudeUsage) ?? null;
};

/** Poll `GET /claude/usage`, returning the latest reading (or null until the first
 *  response lands). Refreshes every POLL_MS and on remount; failures leave the last
 *  good value in place rather than blanking it. */
export function useClaudeUsage(): ClaudeUsage | null {
  return usePolled(fetchUsage, POLL_MS);
}
