import { Box, Group, SegmentedControl, Stack, Text } from "@mantine/core";
import { useState } from "react";
import { TaskStatus } from "../../../shared/types.ts";
import { partitionTasks } from "../../active.ts";
import { usePlanData } from "../../plan-data.ts";
import { FlatView } from "./FlatView.tsx";
import { GoalGroup } from "./GoalGroup.tsx";
import { SelectionBar } from "./SelectionBar.tsx";
import { StartPanel } from "./StartPanel.tsx";
import type { Selection, View } from "./types.ts";

// The Backlog pane is the launchpad — everything to-be-worked (not active),
// grouped goal → milestone as cards (or one flat star-first list). Each card
// carries its launch actions (Start local / Dispatch remote) plus a select
// checkbox: check several and a batch bar launches them as ONE session. Task
// creation is supervisor-only for now (via the API). Milestones and goals with no
// backlog tasks left are hidden here — their finished work lives in the Archive
// pane, so completed work doesn't float around as empty headers.

export function BacklogPane() {
  const { idx, activeIds, loading } = usePlanData();
  const [view, setView] = useState<View>("grouped");
  const [selected, setSelected] = useState<Set<number>>(new Set());

  // Backlog = everything to-be-worked: not active (no live session) and not merged.
  const allTasks = [...idx.tasksByMilestone.values()].flat();
  const { backlog: backlogList } = partitionTasks(allTasks, activeIds);
  const backlogTasks = backlogList.filter((t) => t.status !== TaskStatus.Merged);
  const backlog = new Set(backlogTasks.map((t) => t.id));
  const goals = [...idx.goals].sort((a, b) => a.id - b.id);

  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const selection: Selection = { selected, toggle };

  // The launch order is the rendered backlog order (goal → milestone → position),
  // so the first selected card becomes the primary task of the shared session. Drop
  // any selected ids that are no longer in the backlog (e.g. just launched).
  const selectedIds = backlogTasks.map((t) => t.id).filter((id) => selected.has(id));

  return (
    <Box
      style={{ height: "100%", display: "flex", flexDirection: "column", background: "#1a1b1e" }}
    >
      <Group justify="space-between" px="md" py={8} style={{ flex: "0 0 auto" }}>
        <Group gap={8}>
          <Text size="xs" c="dimmed" fw={700} style={{ letterSpacing: 0.5 }}>
            BACKLOG
          </Text>
          {loading && (
            <Text size="xs" c="dimmed">
              loading…
            </Text>
          )}
        </Group>
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

      <Box style={{ flex: 1, overflowY: "auto" }} px={view === "grouped" ? "md" : 0} py={4}>
        <Box px={view === "grouped" ? 0 : "md"}>
          <StartPanel />
        </Box>
        {goals.length === 0 ? (
          <Text c="dimmed" size="sm" px="md" py="lg">
            No plan loaded. POST one to /plan.
          </Text>
        ) : view === "flat" ? (
          backlogTasks.length === 0 ? (
            <Text c="dimmed" size="sm" px="md" py="lg">
              Backlog is empty — every task is active or done.
            </Text>
          ) : (
            <FlatView tasks={backlogTasks} idx={idx} selection={selection} />
          )
        ) : (
          <Stack gap="xl">
            {goals.map((g) => (
              <GoalGroup key={g.id} goal={g} idx={idx} backlog={backlog} selection={selection} />
            ))}
          </Stack>
        )}
      </Box>

      {selectedIds.length > 0 && (
        <SelectionBar ids={selectedIds} clear={() => setSelected(new Set())} />
      )}
    </Box>
  );
}
