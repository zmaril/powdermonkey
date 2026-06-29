import { Badge, Box, Group, SegmentedControl, Stack, Text } from "@mantine/core";
import type { DockviewPanelApi } from "dockview-react";
import { useState } from "react";
import { usePaneScroll } from "../../pane-scroll.ts";
import { useArchiveData } from "../../plan-data.ts";
import { FlatView } from "./FlatView.tsx";
import { GroupedView } from "./GroupedView.tsx";

// The Archive pane is the book of work — everything finished (merged) or archived.
// Read-only: no launch/land actions, just a browsable record with phase progress
// and links back to the session/PR. Same Flat / Grouped toggle as Active. It comes
// off the same live collections as everything else — no separate fetch or poll.

type View = "flat" | "grouped";

export function ArchivePane({ api }: { api?: DockviewPanelApi }) {
  const { idx, tasks } = useArchiveData();
  const [view, setView] = useState<View>("flat");
  const scroll = usePaneScroll("archive", api); // lint-allow-string: pane scroll key, not an enum value

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
            ARCHIVE
          </Text>
          <Badge size="sm" variant="light" color="gray">
            {tasks.length}
          </Badge>
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

      <Box
        ref={scroll.ref}
        onScroll={scroll.onScroll}
        style={{ flex: 1, overflowY: "auto" }}
        px={view === "grouped" ? "md" : 0}
        py="tight"
      >
        {tasks.length === 0 ? (
          <Text c="dimmed" size="sm" px="md" py="lg">
            Nothing here yet. Tasks land in the archive once they're merged (finished) or archived.
          </Text>
        ) : view === "flat" ? (
          <FlatView tasks={tasks} idx={idx} />
        ) : (
          <GroupedView tasks={tasks} idx={idx} />
        )}
      </Box>
    </Box>
  );
}
