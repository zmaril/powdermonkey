import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Task } from "../../../server/schema.ts";
import { VocabKind } from "../../../shared/types.ts";
import { BacklogCard } from "./BacklogCard.tsx";
import { DragHandle } from "./DragHandle.tsx";
import { tId } from "./reorder.ts";

/** A backlog task card made draggable: a drag handle (in the card header) reorders it
 *  within its milestone or moves it to another, while the rest of the card stays fully
 *  interactive (edit / star / launch / select). The card itself is the sortable node, so
 *  the placeholder gap tracks the drag. */
export function SortableCard({
  task,
  onEditingChange,
}: {
  task: Task;
  onEditingChange?: (editing: boolean) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tId(task.id),
    data: { type: VocabKind.Task },
  });
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.4 : 1,
      }}
    >
      <BacklogCard
        task={task}
        onEditingChange={onEditingChange}
        handle={<DragHandle {...attributes} {...listeners} />}
      />
    </div>
  );
}
