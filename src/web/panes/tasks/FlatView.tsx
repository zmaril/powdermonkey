import type { Task } from "../../../server/schema.ts";
import type { GroupedGhosts } from "../../ghosts.ts";
import { type Indexes, starFirst } from "../../plan-data.ts";
import { useListAnimation } from "../../use-list-animation.ts";
import { BacklogRow } from "./BacklogRow.tsx";

/** Flat backlog: every to-be-worked task in one dense list, starred first, each carrying
 *  its goal › milestone context — plus its pending proposal changes (rename / delete /
 *  move / add-phase) as strips, and any proposed new tasks appended as ghost rows. */
export function FlatView({
  tasks,
  idx,
  ghosts,
}: {
  tasks: Task[];
  idx: Indexes;
  ghosts: GroupedGhosts;
}) {
  const [listRef] = useListAnimation();
  const taskGhosts = [...ghosts.tasksByMilestone.values()].flat();
  return (
    <div ref={listRef}>
      {starFirst(tasks).map((t) => {
        const m = idx.milestoneById.get(t.milestoneId);
        const g = m ? idx.goalById.get(m.goalId) : undefined;
        const context = [g?.title, m?.title].filter(Boolean).join(" › ");
        return <BacklogRow key={t.id} task={t} idx={idx} context={context} />;
      })}
      {taskGhosts.map((g) => (
        <BacklogRow key={`p${g.proposalId}-${g.changeIndex}`} idx={idx} ghost={g} />
      ))}
    </div>
  );
}
