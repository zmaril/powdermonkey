import { Stack } from "@mantine/core";
import type { Task } from "../../../server/schema.ts";
import { type Indexes, starFirst } from "../../plan-data.ts";
import { BacklogRow } from "./BacklogRow.tsx";
import type { Selection } from "./types.ts";

/** Flat backlog: every to-be-worked task in one dense list, starred first, each
 *  carrying its goal › milestone context. The Backlog counterpart to Active's flat. */
export function FlatView({
  tasks,
  idx,
  selection,
}: { tasks: Task[]; idx: Indexes; selection: Selection }) {
  return (
    <Stack gap={0}>
      {starFirst(tasks).map((t) => {
        const m = idx.milestoneById.get(t.milestoneId);
        const g = m ? idx.goalById.get(m.goalId) : undefined;
        const context = [g?.title, m?.title].filter(Boolean).join(" › ");
        return <BacklogRow key={t.id} task={t} idx={idx} context={context} selection={selection} />;
      })}
    </Stack>
  );
}
