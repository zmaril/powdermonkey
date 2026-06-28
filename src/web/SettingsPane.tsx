import { Button, Code, CopyButton, Divider, Group, Stack, Text } from "@mantine/core";
import { useNotificationPermission } from "./notifications.ts";
import { useStore } from "./store.ts";

// One command + a copy button. The shell can't reach into the operator's terminal
// to attach for them — all the UI can do is hand over the exact line to paste.
function CommandRow({ cmd, hint }: { cmd: string; hint: string }) {
  return (
    <div>
      <Group gap={6} wrap="nowrap" justify="space-between">
        <Code style={{ fontSize: 12 }}>{cmd}</Code>
        <CopyButton value={cmd}>
          {({ copied, copy }) => (
            <Button
              size="compact-xs"
              variant={copied ? "light" : "default"}
              color={copied ? "teal" : undefined}
              onClick={copy}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          )}
        </CopyButton>
      </Group>
      <Text size="xs" c="dimmed">
        {hint}
      </Text>
    </div>
  );
}

// Opt into OS web notifications. Browsers only grant permission on a user gesture,
// so this is an explicit button; once granted/denied it reflects the standing state
// (and there's nothing more to do — the choice is the browser's to keep).
function NotifyControl() {
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

// The Settings pane: cross-cutting toggles and supervisor actions that aren't tied
// to a particular task — desktop notifications, the tmux "attach" command, and a
// manual reconcile. Opened from the top bar like any other pane.
export function SettingsPane() {
  const reconcile = useStore((s) => s.reconcile);
  return (
    <div
      style={{ height: "100%", background: "#1a1b1e", display: "flex", flexDirection: "column" }}
    >
      <Group px="md" py={8} style={{ flex: "0 0 auto" }}>
        <Text size="xs" c="dimmed" fw={700} style={{ letterSpacing: 0.5 }}>
          SETTINGS
        </Text>
      </Group>
      <Stack gap="lg" px="md" pb="md" style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        <Stack gap={6}>
          <Text size="sm" fw={600}>
            Notifications
          </Text>
          <NotifyControl />
        </Stack>
        <Divider />
        <Stack gap={6}>
          <Text size="sm" fw={600}>
            Attach
          </Text>
          <Text size="xs" c="dimmed">
            Open the tmux dashboard in your own terminal — one pane per live session, plus the
            server. The browser shell shows one agent at a time; this watches the whole machine.
          </Text>
          <CommandRow cmd="powdermonkey attach" hint="installed globally (npm i -g powdermonkey)" />
          <CommandRow cmd="bun run attach" hint="from a checkout" />
        </Stack>
        <Divider />
        <Stack gap={6}>
          <Text size="sm" fw={600}>
            Maintenance
          </Text>
          <Text size="xs" c="dimmed">
            Reconcile scans <Code style={{ fontSize: 11 }}>main</Code> now for{" "}
            <Code style={{ fontSize: 11 }}>PM-Phase:</Code> trailers and marks finished phases done.
            It also runs on a loop — this is just the manual nudge.
          </Text>
          <Group>
            <Button size="compact-sm" variant="default" onClick={reconcile}>
              Reconcile now
            </Button>
          </Group>
        </Stack>
      </Stack>
    </div>
  );
}
