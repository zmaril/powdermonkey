import { useAutoAnimate } from "@formkit/auto-animate/react";
import { Group, Stack, Title } from "@mantine/core";
import { useState } from "react";
import type { Milestone, Task } from "../../../server/schema.ts";
import type { Indexes } from "../../plan-data.ts";
import { IdTag } from "../../plan-ui";
import { BacklogCard } from "./BacklogCard.tsx";
import { Caret } from "./Caret.tsx";
import { ANIM_OPTS } from "./constants.ts";
import type { Selection } from "./types.ts";

/** A milestone and its backlog cards, with a caret to collapse the lot. */
export function MilestoneGroup({
  milestone,
  tasks,
  idx,
  selection,
}: {
  milestone: Milestone;
  tasks: Task[];
  idx: Indexes;
  selection: Selection;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [listRef] = useAutoAnimate(ANIM_OPTS);
  return (
    <Stack gap="xs" ml={20}>
      <Group gap={6} wrap="nowrap" align="center">
        <Caret
          collapsed={collapsed}
          onToggle={() => setCollapsed((c) => !c)}
          label={collapsed ? "Expand milestone" : "Collapse milestone"}
        />
        <IdTag prefix="m" id={milestone.id} />
        <Title order={5}>{milestone.title}</Title>
      </Group>
      {!collapsed && (
        <div ref={listRef} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {tasks.map((t) => (
            <BacklogCard
              key={t.id}
              task={t}
              phases={idx.phasesByTask.get(t.id) ?? []}
              selection={selection}
            />
          ))}
        </div>
      )}
    </Stack>
  );
}
