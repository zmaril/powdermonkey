import {
  Badge,
  Box,
  Group,
  SegmentedControl,
  Stack,
  Switch,
  Text,
  Title,
  Tooltip,
} from "@mantine/core";
import type { DockviewPanelApi } from "dockview-react";
import { useState } from "react";
import type { Session } from "../../../server/schema.ts";
import { SessionKind } from "../../../shared/types.ts";
import { partitionTasks } from "../../active.ts";
import { usePaneScroll } from "../../pane-scroll.ts";
import { usePlanData } from "../../plan-data.ts";
import { KIND_ICON } from "../../plan-ui";
import { useStore } from "../../store.ts";
import { FlatView } from "./FlatView.tsx";
import { GroupedView } from "./GroupedView.tsx";
import type { View } from "./grouping.ts";

// The Active pane is the live monitor — every task with a session running right
// now (the derived-active set; see active.ts). The unit here is the WORKER, not
// the task: each live session renders as one card, because a single worker can be
// dispatched for several tasks at once (the session_tasks join). The card header
// carries everything session-level — kind, state (once), session link, Teleport,
// Stop — and the task(s) nest below showing only what's per-task (star, id, title,
// their own PR/CI status). Two views, toggled:
//   • Flat   — worker cards in one list.
//   • Grouped — the same cards nested under goal → milestone.
// It re-renders off the same 4s poll as the rest of the app, so session state
// (running / Try Again / needs you) stays current without a refresh.

export function ActivePane({ api }: { api?: DockviewPanelApi }) {
  const { idx, activeIds } = usePlanData();
  const autoRebase = useStore((s) => s.autoRebase);
  const setAutoRebase = useStore((s) => s.setAutoRebase);
  const [view, setView] = useState<View>("flat");
  const scroll = usePaneScroll("active", api);

  const allTasks = [...idx.tasksByMilestone.values()].flat();
  const { active } = partitionTasks(allTasks, activeIds);
  // The ACTIVE count is the number of WORKERS (distinct live sessions), not tasks —
  // one worker can carry several tasks, so counting tasks overstates what's running.
  // Broken out per environment: how many cloud workers vs local worktrees.
  const activeSessions = new Map<number, Session>();
  for (const t of active) {
    const s = idx.sessionByTask.get(t.id);
    if (s) activeSessions.set(s.id, s);
  }
  const cloudCount = [...activeSessions.values()].filter(
    (s) => s.kind === SessionKind.Remote,
  ).length;
  const localCount = [...activeSessions.values()].filter(
    (s) => s.kind === SessionKind.Local,
  ).length;
  const RemoteIcon = KIND_ICON[SessionKind.Remote];
  const LocalIcon = KIND_ICON[SessionKind.Local];

  return (
    <Box
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: "var(--pm-pane-bg)",
      }}
    >
      <Group justify="space-between" px="md" py="cozy" style={{ flex: "0 0 auto" }}>
        <Group gap="cozy">
          <Text size="xs" c="dimmed" fw={700} style={{ letterSpacing: 0.5 }}>
            ACTIVE
          </Text>
          <Badge
            size="sm"
            variant="light"
            color={cloudCount > 0 ? "blue" : "gray"}
            title="cloud sessions"
            leftSection={<RemoteIcon size={12} />}
          >
            {cloudCount}
          </Badge>
          <Badge
            size="sm"
            variant="light"
            color={localCount > 0 ? "blue" : "gray"}
            title="local sessions"
            leftSection={<LocalIcon size={12} />}
          >
            {localCount}
          </Badge>
        </Group>
        <Group gap="md" wrap="nowrap">
          <Tooltip
            label="Auto-ask @claude to rebase a PR that conflicts with main. Turn off to drive rebases by hand."
            multiline
            w={240}
            withArrow
          >
            <Switch
              size="xs"
              checked={autoRebase}
              onChange={(e) => setAutoRebase(e.currentTarget.checked)}
              label="auto-rebase"
              labelPosition="left"
              styles={{
                label: { fontSize: "var(--mantine-font-size-xs)", color: "var(--pm-dim-text)" },
              }}
            />
          </Tooltip>
          <SegmentedControl
            size="xs"
            value={view}
            onChange={(v) => setView(v as View)}
            data={[
              { label: "Flat", value: "flat" },
              { label: "Grouped", value: "grouped" },
            ]}
          />
        </Group>
      </Group>

      <Box
        ref={scroll.ref}
        onScroll={scroll.onScroll}
        style={{ flex: 1, overflowY: "auto" }}
        px="md"
        py="xs"
      >
        {active.length === 0 ? (
          <Text c="dimmed" size="sm" py="lg">
            Nothing active. Launch a task from the Backlog (Start local / Dispatch remote, or "/" →
            Start local on a new line) and it shows up here.
          </Text>
        ) : view === "flat" ? (
          <FlatView tasks={active} idx={idx} />
        ) : (
          <GroupedView activeIds={activeIds} idx={idx} />
        )}
      </Box>
    </Box>
  );
}
