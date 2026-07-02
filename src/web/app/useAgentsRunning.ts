import { useLiveQuery } from "@tanstack/react-db";
import { sessionsCollection } from "../collections.ts";
import { countRunningAgents } from "./agents-running.ts";

/** Live count of running agents, reactive off the synced sessions collection — it
 *  ticks the instant a session is created, lands, or is stopped (no poll). The count
 *  itself is countRunningAgents (pure, tested separately). */
export function useAgentsRunning(): number {
  const sessions = useLiveQuery(() => sessionsCollection);
  return countRunningAgents(sessions.data ?? []);
}
