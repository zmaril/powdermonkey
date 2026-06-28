import { Stack } from "@mantine/core";
import type { Task } from "../../../server/schema.ts";
import type { Indexes } from "../../plan-data.ts";
import { ArchiveRow } from "./ArchiveRow.tsx";

export function FlatView({ tasks, idx }: { tasks: Task[]; idx: Indexes }) {
  // Newest first — the most recently finished work sits at the top.
  const ordered = [...tasks].sort((a, b) => b.id - a.id);
  return (
    <Stack gap={0}>
      {ordered.map((t) => {
        const m = idx.milestoneById.get(t.milestoneId);
        const g = m ? idx.goalById.get(m.goalId) : undefined;
        const context = [g?.title, m?.title].filter(Boolean).join(" › ");
        return <ArchiveRow key={t.id} task={t} context={context} />;
      })}
    </Stack>
  );
}
