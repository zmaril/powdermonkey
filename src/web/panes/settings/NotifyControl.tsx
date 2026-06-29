import { Button, Group, Text } from "@mantine/core";
import { useNotificationPermission } from "../../notifications.ts";

// Opt into OS web notifications. Browsers only grant permission on a user gesture,
// so this is an explicit button; once granted/denied it reflects the standing state
// (and there's nothing more to do — the choice is the browser's to keep).
export function NotifyControl() {
  const { permission, request } = useNotificationPermission();
  if (permission === "unsupported") {
    return (
      <Text size="xs" c="dimmed">
        Your browser doesn't support desktop notifications.
      </Text>
    );
  }
  const label =
    permission === "granted" ? "🔔 On" : permission === "denied" ? "🔕 Blocked" : "🔔 Enable";
  return (
    <Group gap="sm" wrap="nowrap">
      <Button
        size="compact-sm"
        variant="default"
        onClick={request}
        disabled={permission !== "default"}
      >
        {label}
      </Button>
      <Text size="xs" c="dimmed">
        {permission === "granted"
          ? "You'll be pinged when a session needs you."
          : permission === "denied"
            ? "Notifications are blocked in your browser settings."
            : "Get a desktop ping when a session falls idle waiting for you."}
      </Text>
    </Group>
  );
}
