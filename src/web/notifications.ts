import { useEffect, useRef, useState } from "react";
import type { Session } from "../server/schema.ts";
import { useStore } from "./store.ts";

// OS-level web notifications: ping the operator when a session falls idle at a
// prompt ("needs you"). This is the away-from-the-app layer — distinct from the
// in-app tab indicators (which are glanceable while you're looking at the UI).
// Permission is requested explicitly from the top bar (browsers only grant it on
// a user gesture), and notifications fire only on the false→true needs_input edge
// so a session parked at a prompt pings once, not on every poll.

export type NotifyPermission = NotificationPermission | "unsupported";

/** The browser exposes the Notification API (absent in SSR / older browsers). */
export function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

/** Current permission, or "unsupported" when the API isn't present. */
export function notificationPermission(): NotifyPermission {
  return notificationsSupported() ? Notification.permission : "unsupported";
}

/** Ask the browser for permission (must be called from a user gesture). Resolves
 *  to the resulting permission, or "unsupported" when the API is missing. */
export async function requestNotificationPermission(): Promise<NotifyPermission> {
  if (!notificationsSupported()) return "unsupported";
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

/** Sessions that just transitioned into needs_input (was false/absent, now true).
 *  Pure so it can be unit-tested; the caller owns the previous snapshot. A session
 *  that was already needs_input — or already known to be — is not an edge. */
export function needsInputEdges(prev: Map<number, boolean>, sessions: Session[]): Session[] {
  const edges: Session[] = [];
  for (const s of sessions) {
    if (s.needsInput && !prev.get(s.id)) edges.push(s);
  }
  return edges;
}

/** Snapshot the needs_input flag per session id, for edge detection next tick. */
export function snapshotNeedsInput(sessions: Session[]): Map<number, boolean> {
  const m = new Map<number, boolean>();
  for (const s of sessions) m.set(s.id, s.needsInput);
  return m;
}

/** A short human label for the session that needs attention, preferring the title
 *  of a task it's working over the bare branch/id. */
function sessionLabel(session: Session): string {
  const { tasks, sessionTasks } = useStore.getState();
  const taskId = sessionTasks.find((l) => l.sessionId === session.id)?.taskId;
  const task = taskId != null ? tasks.find((t) => t.id === taskId) : undefined;
  if (task) return `t${task.id} · ${task.title}`;
  if (session.branch) return session.branch;
  return `session ${session.id}`;
}

function fireNeedsInputNotification(session: Session): void {
  if (!notificationsSupported() || Notification.permission !== "granted") return;
  try {
    const n = new Notification("A session needs you", {
      body: sessionLabel(session),
      tag: `pm-needs-input-${session.id}`,
      icon: "/favicon.ico",
    });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {}
}

/** Watch the store's sessions and fire an OS notification on each false→true
 *  needs_input edge. The first run only seeds the snapshot (so a reload doesn't
 *  ping about sessions that were already parked); subsequent runs notify on edges. */
export function useNeedsInputNotifications(): void {
  const sessions = useStore((s) => s.sessions);
  const prev = useRef<Map<number, boolean> | null>(null);
  useEffect(() => {
    if (prev.current === null) {
      prev.current = snapshotNeedsInput(sessions);
      return;
    }
    for (const s of needsInputEdges(prev.current, sessions)) fireNeedsInputNotification(s);
    prev.current = snapshotNeedsInput(sessions);
  }, [sessions]);
}

/** Top-bar control state: a reactive permission value plus a request action. */
export function useNotificationPermission(): {
  permission: NotifyPermission;
  request: () => void;
} {
  const [permission, setPermission] = useState<NotifyPermission>(() => notificationPermission());
  const request = () => {
    void requestNotificationPermission().then(setPermission);
  };
  return { permission, request };
}
