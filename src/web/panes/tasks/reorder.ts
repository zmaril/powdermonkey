import type { DragEndEvent, DragOverEvent, DragStartEvent } from "@dnd-kit/core";
import { KeyboardSensor, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { arrayMove, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { useEffect, useRef, useState } from "react";
import type { Goal, Milestone, Task } from "../../../server/schema.ts";
import { VocabKind } from "../../../shared/types.ts";
import { api } from "../../client.ts";
import type { Indexes } from "../../plan-data.ts";

// Drag-and-drop reordering for the grouped Backlog: reorder milestones within a goal,
// and reorder/move tasks within and between milestones. This holds the FULL plan order
// (every non-archived milestone/task, in position order) as an optimistic local copy so
// a drop doesn't snap back while the PATCHes round-trip — the grouped view filters this
// to the to-be-worked subset for display, but we persist over the full list so a hidden
// (active / merged) task's position is never clobbered. Writes go through the typed
// client and stream back over /sync; a signature guard re-adopts server truth once our
// own writes echo back. (This is the reorder/move half of direct plan editing.)

// Sortable/droppable id encoding — prefixes keep milestone ids, task ids, and the
// per-milestone task-drop container distinct in one shared DndContext.
export const mId = (id: number) => `m${id}`;
export const tId = (id: number) => `t${id}`;
export const cId = (id: number) => `c${id}`; // a milestone's task-list drop container
const num = (sid: string) => Number(sid.slice(1));

// The full, optimistic plan order plus the row maps for persistence + overlay labels.
type Order = {
  goals: Goal[];
  milestonesByGoal: Record<number, number[]>; // goalId → ordered milestone ids (full)
  tasksByMilestone: Record<number, number[]>; // milestoneId → ordered task ids (full)
  milestoneMap: Record<number, Milestone>;
  taskMap: Record<number, Task>;
};

function seed(idx: Indexes): Order {
  const goals = [...idx.goals].sort((a, b) => a.id - b.id);
  const milestonesByGoal: Record<number, number[]> = {};
  const milestoneMap: Record<number, Milestone> = {};
  for (const g of goals) {
    const ms = idx.milestonesByGoal.get(g.id) ?? [];
    milestonesByGoal[g.id] = ms.map((m) => m.id);
    for (const m of ms) milestoneMap[m.id] = m;
  }
  const tasksByMilestone: Record<number, number[]> = {};
  const taskMap: Record<number, Task> = {};
  for (const m of Object.values(milestoneMap)) {
    const ts = idx.tasksByMilestone.get(m.id) ?? [];
    tasksByMilestone[m.id] = ts.map((t) => t.id);
    for (const t of ts) taskMap[t.id] = t;
  }
  return { goals, milestonesByGoal, tasksByMilestone, milestoneMap, taskMap };
}

// The ordering we'd persist (what a drop changes) and the membership fingerprint (which
// ids exist) — compared against an in-flight write so we hold the optimistic order until
// it echoes back, but adopt an out-of-band add/remove immediately.
const sig = (o: Order) => JSON.stringify({ m: o.milestonesByGoal, t: o.tasksByMilestone });
const members = (o: Order) =>
  JSON.stringify([
    o.goals.map((g) => g.id),
    Object.keys(o.taskMap)
      .map(Number)
      .sort((a, b) => a - b),
    Object.keys(o.milestoneMap)
      .map(Number)
      .sort((a, b) => a - b),
  ]);

function taskContainer(o: Order, taskId: number): number | null {
  for (const [m, list] of Object.entries(o.tasksByMilestone))
    if (list.includes(taskId)) return Number(m);
  return null;
}
function milestoneGoal(o: Order, milestoneId: number): number | null {
  for (const [g, list] of Object.entries(o.milestonesByGoal))
    if (list.includes(milestoneId)) return Number(g);
  return null;
}
/** The milestone a drop landed on, whatever the `over` target is: a milestone header
 *  (`m…`), its task container (`c…`), or a task inside it (`t…`). */
function overMilestone(o: Order, overSid: string): number | null {
  if (overSid[0] === "m" || overSid[0] === "c") return num(overSid);
  if (overSid[0] === "t") return taskContainer(o, num(overSid));
  return null;
}

export type Reorder = {
  /** Optimistic ordered milestone ids for a goal (full — callers filter to what's shown). */
  milestoneOrder: (goalId: number) => number[];
  /** Optimistic ordered task ids for a milestone (full — callers filter to the backlog). */
  taskOrder: (milestoneId: number) => number[];
  /** A task row by id, resolved across milestones (a mid-move task still lives under its
   *  old milestone in the indexes, so callers can't look it up there). */
  taskById: (id: number) => Task | undefined;
  sensors: ReturnType<typeof useSensors>;
  activeId: string | null;
  draggedLabel: string | null;
  onDragStart: (e: DragStartEvent) => void;
  onDragOver: (e: DragOverEvent) => void;
  onDragEnd: (e: DragEndEvent) => void;
};

export function useBacklogReorder(idx: Indexes): Reorder {
  const [order, setOrder] = useState<Order>(() => seed(idx));
  const [activeId, setActiveId] = useState<string | null>(null);
  // The signature of an optimistic edit we've PATCHed but not yet seen echo back.
  const pendingSig = useRef<string | null>(null);

  // Adopt server truth, but don't clobber an in-flight optimistic reorder.
  useEffect(() => {
    const server = seed(idx);
    setOrder((prev) => {
      if (pendingSig.current) {
        if (sig(server) === pendingSig.current || members(server) !== members(prev)) {
          pendingSig.current = null;
          return server;
        }
        return prev; // still waiting for our own write to land
      }
      return sig(server) === sig(prev) && members(server) === members(prev) ? prev : server;
    });
  }, [idx]);

  const sensors = useSensors(
    // A small distance threshold so a click on the handle isn't read as a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragStart = (e: DragStartEvent) => setActiveId(String(e.active.id));

  // Live cross-milestone feedback: while dragging a task over a different milestone, move
  // it there in the optimistic order so the placeholder shows in the target.
  const onDragOver = (e: DragOverEvent) => {
    const { active, over } = e;
    if (!over || active.data.current?.type !== VocabKind.Task) return;
    const activeTask = num(String(active.id));
    const overSid = String(over.id);
    const target = overMilestone(order, overSid);
    const source = taskContainer(order, activeTask);
    if (target == null || source == null || source === target) return;
    setOrder((prev) => {
      const src = prev.tasksByMilestone[source].filter((id) => id !== activeTask);
      const dst = [...prev.tasksByMilestone[target]];
      const overIdx = overSid[0] === "t" ? dst.indexOf(num(overSid)) : -1;
      dst.splice(overIdx >= 0 ? overIdx : dst.length, 0, activeTask);
      return {
        ...prev,
        tasksByMilestone: { ...prev.tasksByMilestone, [source]: src, [target]: dst },
      };
    });
  };

  const onDragEnd = (e: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = e;
    if (!over) return;
    const activeSid = String(active.id);
    const overSid = String(over.id);

    if (active.data.current?.type === VocabKind.Milestone) {
      // Reorder within the goal only — ignore a drop onto a milestone in another goal.
      const activeM = num(activeSid);
      const targetM = overMilestone(order, overSid);
      if (targetM == null) return;
      const goal = milestoneGoal(order, activeM);
      const overGoal = milestoneGoal(order, targetM);
      if (goal == null || overGoal == null || goal !== overGoal || activeM === targetM) return;
      const list = order.milestonesByGoal[goal];
      const next = arrayMove(list, list.indexOf(activeM), list.indexOf(targetM));
      commit({ ...order, milestonesByGoal: { ...order.milestonesByGoal, [goal]: next } });
      return;
    }

    if (active.data.current?.type === VocabKind.Task) {
      // onDragOver has already placed the task in the right container; here we only settle
      // the within-container order when dropped onto a sibling task.
      const activeTask = num(activeSid);
      const container = taskContainer(order, activeTask);
      if (container == null) return;
      let next = order;
      if (
        overSid[0] === "t" &&
        taskContainer(order, num(overSid)) === container &&
        activeSid !== overSid
      ) {
        const list = order.tasksByMilestone[container];
        const moved = arrayMove(list, list.indexOf(activeTask), list.indexOf(num(overSid)));
        next = { ...order, tasksByMilestone: { ...order.tasksByMilestone, [container]: moved } };
      }
      commit(next);
    }
  };

  // Persist a finished edit: diff the new ordering against server `position` /
  // `milestoneId` and PATCH only the rows that moved. Hold the optimistic order (via
  // pendingSig) until those writes echo back over /sync.
  const commit = (next: Order) => {
    setOrder(next);
    pendingSig.current = sig(next);
    const writes: Promise<{ error?: unknown }>[] = [];
    for (const list of Object.values(next.milestonesByGoal)) {
      list.forEach((id, i) => {
        const m = next.milestoneMap[id];
        if (m && m.position !== i) writes.push(api.milestones({ id: m.id }).patch({ position: i }));
      });
    }
    for (const [m, list] of Object.entries(next.tasksByMilestone)) {
      const milestoneId = Number(m);
      list.forEach((id, i) => {
        const t = next.taskMap[id];
        if (t && (t.position !== i || t.milestoneId !== milestoneId))
          writes.push(api.tasks({ id: t.id }).patch({ position: i, milestoneId }));
      });
    }
    if (writes.length === 0) pendingSig.current = null;
  };

  const draggedLabel =
    activeId == null
      ? null
      : activeId[0] === "m"
        ? (order.milestoneMap[num(activeId)]?.title ?? null)
        : (order.taskMap[num(activeId)]?.title ?? null);

  return {
    milestoneOrder: (goalId) => order.milestonesByGoal[goalId] ?? [],
    taskOrder: (milestoneId) => order.tasksByMilestone[milestoneId] ?? [],
    taskById: (id) => order.taskMap[id],
    sensors,
    activeId,
    draggedLabel,
    onDragStart,
    onDragOver,
    onDragEnd,
  };
}
