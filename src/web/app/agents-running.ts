import type { Session } from "../../server/schema.ts";
import { SessionBucket, sessionBucket } from "../panes/filters.ts";

// The count behind the status bar: how many agents are running right now. An "agent
// running" is a live session (local worktree or remote `claude --remote`) — exactly
// the Sessions pane's Live/"Running" bucket, so the bar's number and the pane's
// filtered list can never disagree. Kept pure and free of the sync collections so it's
// unit-testable; the hook (useAgentsRunning) wires it to live data.

/** Count the sessions that are running right now (the Live bucket — non-archived). */
export function countRunningAgents(sessions: Session[]): number {
  return sessions.filter((s) => sessionBucket(s) === SessionBucket.Live).length;
}
