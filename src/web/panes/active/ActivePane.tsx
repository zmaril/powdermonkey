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
import { useState } from "react";
import { partitionTasks } from "../../active.ts";
import { usePlanData } from "../../plan-data.ts";
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

export function ActivePane() {
  const { idx, activeIds } = usePlanData();
  const autoRebase = useStore((s) => s.autoRebase);
  const setAutoRebase = useStore((s) => s.setAutoRebase);
  const [view, setView] = useState<View>("flat");

  const allTasks = [...idx.tasksByMilestone.values()].flat();
  const { active } = partitionTasks(allTasks, activeIds);

  return (
    <Box
      style={{ height: "100%", display: "flex", flexDirection: "column", background: "#1a1b1e" }}
    >
      <Group justify="space-between" px="md" py={8} style={{ flex: "0 0 auto" }}>
        <Group gap={8}>
          <Text size="xs" c="dimmed" fw={700} style={{ letterSpacing: 0.5 }}>
            ACTIVE
          </Text>
          <Badge size="sm" variant="light" color={active.length > 0 ? "blue" : "gray"}>
            {active.length}
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
              styles={{ label: { fontSize: "var(--mantine-font-size-xs)", color: "#909296" } }}
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

      <Box style={{ flex: 1, overflowY: "auto" }} px="md" py="xs">
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
