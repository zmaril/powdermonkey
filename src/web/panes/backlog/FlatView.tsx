import { useAutoAnimate } from "@formkit/auto-animate/react";
import type { Task } from "../../../server/schema.ts";
import { VocabKind } from "../../../shared/types.ts";
import { type EntityEdit, type GroupedGhosts, entityKey } from "../../ghosts.ts";
import { type Indexes, starFirst } from "../../plan-data.ts";
import { BacklogRow } from "./BacklogRow.tsx";
import { ANIM_OPTS } from "./constants.ts";
import type { Selection } from "./types.ts";

/** Flat backlog: every to-be-worked task in one dense list, starred first, each carrying
 *  its goal › milestone context — plus its pending proposal changes (rename / delete /
 *  move / add-phase) as strips, and any proposed new tasks appended as ghost rows. */
export function FlatView({
  tasks,
  idx,
  selection,
  ghosts,
  edits,
}: {
  tasks: Task[];
  idx: Indexes;
  selection: Selection;
  ghosts: GroupedGhosts;
  edits: Map<string, EntityEdit[]>;
}) {
  const [listRef] = useAutoAnimate(ANIM_OPTS);
  const taskGhosts = [...ghosts.tasksByMilestone.values()].flat();
  return (
    <div ref={listRef}>
      {starFirst(tasks).map((t) => {
        const m = idx.milestoneById.get(t.milestoneId);
        const g = m ? idx.goalById.get(m.goalId) : undefined;
        const context = [g?.title, m?.title].filter(Boolean).join(" › ");
        const taskPhases = idx.phasesByTask.get(t.id) ?? [];
        return (
          <BacklogRow
            key={t.id}
            task={t}
            idx={idx}
            context={context}
            selection={selection}
            edits={edits.get(entityKey(VocabKind.Task, t.id))}
            phaseGhosts={ghosts.phasesByTask.get(t.id)}
            phaseEdits={taskPhases.flatMap(
              (p) => edits.get(entityKey(VocabKind.Phase, p.id)) ?? [],
            )}
          />
        );
      })}
      {taskGhosts.map((g) => (
        <BacklogRow
          key={`p${g.proposalId}-${g.changeIndex}`}
          idx={idx}
          selection={selection}
          ghost={g}
        />
      ))}
    </div>
  );
}
