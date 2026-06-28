import type { Session, Task } from "../server/schema.ts";
import type { SessionLink } from "./active.ts";

// Browser-notification plumbing for "a session needs you". Two concerns live here,
// both kept free of React so the edge logic is unit-testable without a DOM: the
// Notification API permission helpers, and the pure functions that turn successive
// session snapshots into the set of sessions that JUST started needing input. The
// React hook that drives them off the store lives in App.tsx.

export type NotifyPermission = "default" | "granted" | "denied" | "unsupported";

/** Current Notification API permission, or "unsupported" where the API is absent
 *  (older browsers, insecure origins). Callers branch the UI on this. */
export function notifyPermission(): NotifyPermission {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission as NotifyPermission;
}

/** Ask the browser to allow notifications. A no-op once the user has decided —
 *  granted/denied are sticky and can't be re-prompted — so this only shows the
 *  prompt from the "default" state. Returns the resulting permission. */
export async function requestNotifyPermission(): Promise<NotifyPermission> {
  if (typeof Notification === "undefined") return "unsupported";
  if (Notification.permission !== "default") return Notification.permission as NotifyPermission;
  try {
    return (await Notification.requestPermission()) as NotifyPermission;
  } catch {
    return Notification.permission as NotifyPermission;
  }
}

type NeedsInputRow = Pick<Session, "id" | "needsInput">;

/** Snapshot every session's needs-input flag, for the next edge comparison. */
export function needsInputMap(sessions: NeedsInputRow[]): Map<number, boolean> {
  return new Map(sessions.map((s) => [s.id, s.needsInput]));
}

/** Session ids that just crossed false/absent → true for `needsInput`. Pure, so the
 *  edge detection is testable without a browser. A session missing from `prev`
 *  counts as having been false, so a session that appears already-parked is treated
 *  as a fresh edge (the caller seeds a baseline first to suppress that at load). */
export function risingNeedsInput(prev: Map<number, boolean>, sessions: NeedsInputRow[]): number[] {
  const ids: number[] = [];
  for (const s of sessions) if (s.needsInput && !prev.get(s.id)) ids.push(s.id);
  return ids;
}

/** Human label for a session's notification: the titles of the task(s) it's working,
 *  falling back to its branch, then its id. Keeps the alert meaningful ("needs you:
 *  Wire up notifications") rather than an opaque session number. */
export function sessionLabel(
  sessionId: number,
  links: SessionLink[],
  tasks: Task[],
  session?: Session,
): string {
  const taskIds = new Set(links.filter((l) => l.sessionId === sessionId).map((l) => l.taskId));
  const titles = tasks.filter((t) => taskIds.has(t.id)).map((t) => t.title);
  if (titles.length > 0) return titles.join(", ");
  return session?.branch ?? `session ${sessionId}`;
}
