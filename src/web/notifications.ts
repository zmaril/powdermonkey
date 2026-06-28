// Browser-notification plumbing for "a session needs you". The Notification API
// permission helpers live here, kept free of React so the UI button can branch on
// permission without pulling in a component. The React hook that fires alerts off
// the store lives in App.tsx.

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
