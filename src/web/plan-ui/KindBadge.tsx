import { Badge } from "@mantine/core";
import { type TaskKind, TaskKind as TaskKindEnum } from "../../shared/types.ts";
import { TASK_KIND_COLOR } from "./constants.ts";

/** The task-kind flag on a card (bug / spike). A plain `task` renders nothing —
 *  flagging the default kind on every card would be noise; only the discovery-first
 *  kinds earn a badge. The label is the kind value itself. */
export function KindBadge({ kind }: { kind: TaskKind }) {
  if (kind === TaskKindEnum.Task) return null;
  return (
    <Badge color={TASK_KIND_COLOR[kind]} variant="light" style={{ flexShrink: 0 }}>
      {kind}
    </Badge>
  );
}
