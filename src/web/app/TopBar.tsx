import { ActionIcon, Divider, Group, Text, Tooltip } from "@mantine/core";
import { IconPlus } from "@tabler/icons-react";
import { useLiveQuery } from "@tanstack/react-db";
import { tasksCollection } from "../collections.ts";
import { useStore } from "../store.ts";
import { openNewWindow } from "../window-bridge.ts";
import { PaneButton } from "./PaneButton.tsx";
import { AgentsCluster } from "./status/AgentsCluster.tsx";
import { ClaudeUsageCluster } from "./status/ClaudeUsageCluster.tsx";
import { useAgentsRunning } from "./useAgentsRunning.ts";
import { useClaudeUsage } from "./useClaudeUsage.ts";

// Slim global toolbar: the wordmark, the two always-on-glance status readouts (agents
// running by the wordmark, Claude usage by the launchers), the error banner, and a
// launcher for every pane type. Click one and the pane appears (or comes forward)
// below — singletons focus their one instance, Shell/Browser open a fresh one each
// time. Lives above the dockview so it's always reachable regardless of which panel is
// focused. The agents count is reactive off the sessions collection; the usage reading
// is polled (see useClaudeUsage) and degrades to a dim note when there's no login.
export function TopBar() {
  const openPane = useStore((s) => s.openPane);
  const openTerminal = useStore((s) => s.openTerminal);
  const openBrowser = useStore((s) => s.openBrowser);
  const openRepoPicker = useStore((s) => s.openRepoPicker);
  const error = useStore((s) => s.error);
  // "loading" until the first collection snapshot lands.
  const loading = useLiveQuery(() => tasksCollection).isLoading;
  const running = useAgentsRunning();
  const usage = useClaudeUsage();
  return (
    <div
      style={{
        flex: "0 0 auto",
        borderBottom: "1px solid var(--pm-hairline)",
        background: "var(--pm-tab-strip)",
      }}
    >
      <Group justify="space-between" px="md" py="cozy" wrap="nowrap">
        <Group gap="sm" wrap="nowrap" align="baseline">
          <Text fw={650} size="md" style={{ letterSpacing: "-0.01em" }}>
            PowderMonkey
          </Text>
          {loading && (
            <Text size="xs" c="dimmed">
              loading…
            </Text>
          )}
          {error && (
            <Text size="xs" c="red" truncate maw={420} title={error}>
              {error}
            </Text>
          )}
          <AgentsCluster running={running} />
        </Group>
        <Group gap="hair" wrap="nowrap" align="center">
          <ClaudeUsageCluster usage={usage} />
          <Divider orientation="vertical" my="tight" />
          {/* Open a real new OS window (Tauri WebviewWindow / browser window), the
              cross-platform affordance for Cmd/Ctrl-N. Opens unscoped; scope it from
              the new window's repo tab strip. */}
          <Tooltip label="New window (⌘N)" withArrow>
            <ActionIcon
              variant="subtle"
              color="gray"
              size="md"
              onClick={() => openNewWindow()}
              aria-label="New window"
            >
              <IconPlus size={16} />
            </ActionIcon>
          </Tooltip>
          <Divider orientation="vertical" my="tight" />
          <PaneButton label="Sessions" onClick={() => openPane("sessions")} />
          <PaneButton label="Tasks" onClick={() => openPane("tasks")} />
          {/* The Blender-style picker, unscoped: add repos to the registry
              (fork-first) without touching any window's tabs. */}
          <PaneButton label="Repos" onClick={() => openRepoPicker()} />
          <Divider orientation="vertical" my="tight" />
          <PaneButton label="Shell" onClick={() => openTerminal("")} />
          <PaneButton label="Browser" onClick={() => openBrowser()} />
          <PaneButton label="Scratch" onClick={() => openPane("scratch")} />
          <Divider orientation="vertical" my="tight" />
          <PaneButton label="Settings" onClick={() => openPane("settings")} />
          <PaneButton label="About" onClick={() => openPane("about")} />
          <PaneButton label="Help" onClick={() => openPane("help")} />
        </Group>
      </Group>
    </div>
  );
}
