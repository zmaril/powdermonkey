import { Stack } from "@mantine/core";
import type { Task } from "../../../server/schema.ts";
import type { Indexes } from "../../plan-data.ts";
import { starFirst } from "../../plan-data.ts";
import { WorkerCard } from "./WorkerCard.tsx";
import { groupBySession } from "./grouping.ts";

export function FlatView({ tasks, idx }: { tasks: Task[]; idx: Indexes }) {
  const groups = groupBySession(starFirst(tasks), idx);
  return (
    <Stack gap="xs">
      {groups.map((g) => (
        <WorkerCard key={g.session.id} session={g.session} tasks={g.tasks} idx={idx} showContext />
      ))}
    </Stack>
  );
}
