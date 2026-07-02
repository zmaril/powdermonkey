import { useLiveQuery } from "@tanstack/react-db";
import { useEffect, useState } from "react";
import type { ClaudeUsage } from "../shared/types.ts";
import { runningAgentCount } from "./active.ts";
import { sessionsCollection } from "./collections.ts";
import { apiUrl } from "./server.ts";

// The live data behind the global status bar. Supervisor-wide, not window-scoped:
// one supervisor sees every repo and session at once, so these numbers are the whole
// picture regardless of which window is in front (docs/vocabulary.md → Global status
// bar). The agents count comes straight off the synced sessions collection — it
// re-renders as sessions start and land, no poll. Claude usage/limits isn't a synced
// table (it's read live off the operator's Claude Code login server-side), so it's
// polled over /claude-usage instead.

/** Live count of running agents — active sessions across all repos. Reads the
 *  sessions collection directly and re-derives on every delta, so the bar's count
 *  tracks reality without a refetch. */
export function useRunningAgents(): number {
  const sessions = useLiveQuery(() => sessionsCollection);
  return runningAgentCount(sessions.data ?? []);
}

// The server TTL-caches usage for ~60s, so polling faster just returns the same
// snapshot; match that cadence.
const USAGE_POLL_MS = 60_000;

/** Poll the Claude usage/limits snapshot for the bar. Returns null until the first
 *  read lands; on a failed poll it keeps the last-known snapshot rather than blanking
 *  (the snapshot already carries its own `available:false` when the numbers are
 *  degraded — a fetch failure is a transport problem, not a usage state). */
export function useClaudeUsage(): ClaudeUsage | null {
  const [usage, setUsage] = useState<ClaudeUsage | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(apiUrl("/claude-usage"), { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as ClaudeUsage;
        if (alive) setUsage(data);
      } catch {
        // Transport error — leave the last-known snapshot in place.
      }
    };
    load();
    const timer = setInterval(load, USAGE_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  return usage;
}
