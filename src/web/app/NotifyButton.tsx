import { Button } from "@mantine/core";
import { useNotificationPermission } from "../notifications.ts";

// Opt into OS web notifications. Browsers only grant permission on a user gesture,
// so this is an explicit button; once granted/denied it reflects the standing
// state (and there's nothing more to do — the choice is the browser's to keep).
export function NotifyButton() {
  const { permission, request } = useNotificationPermission();
  if (permission === "unsupported") return null;
  const label =
    permission === "granted" ? "🔔 On" : permission === "denied" ? "🔕 Blocked" : "🔔 Notify";
  return (
    <Button
      size="compact-xs"
      variant="default"
      onClick={request}
      disabled={permission !== "default"}
      title={
        permission === "granted"
          ? "Desktop notifications are on — you'll be pinged when a session needs you"
          : permission === "denied"
            ? "Notifications are blocked in your browser settings"
            : "Enable desktop notifications when a session needs you"
      }
    >
      {label}
    </Button>
  );
}
