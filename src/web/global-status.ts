import { useLiveQuery } from "@tanstack/react-db";
import { runningAgentCount } from "./active.ts";
import { sessionsCollection } from "./collections.ts";

// The live data behind the global status bar. Supervisor-wide, not window-scoped:
// one supervisor sees every repo and session at once, so these numbers are the whole
// picture regardless of which window is in front (docs/vocabulary.md → Global status
// bar). The agents count comes straight off the synced sessions collection — it
// re-renders as sessions start and land, no poll. (Claude usage/limits is fetched
// separately over /claude-usage; see the bar component.)

/** Live count of running agents — active sessions across all repos. Reads the
 *  sessions collection directly and re-derives on every delta, so the bar's count
 *  tracks reality without a refetch. */
export function useRunningAgents(): number {
  const sessions = useLiveQuery(() => sessionsCollection);
  return runningAgentCount(sessions.data ?? []);
}
