import { Badge, Group } from "@mantine/core";
import type { Session, Task } from "../../server/schema.ts";
import { SESSION_BADGE, STATUS_COLOR } from "./constants.ts";
import { KindBadge } from "./KindBadge.tsx";

/** The session/status badge cluster shown next to a task title. `showStatus` is off
 *  in the Active pane — every active task is "dispatched" by definition, so the
 *  status badge there is just noise next to the live session state. */
export function TaskBadges({
  task,
  session,
  showStatus = true,
}: {
  task: Task;
  session?: Session;
  showStatus?: boolean;
}) {
  // The live session row is the real signal ("is it running"); local/teleported
  // sessions never set the denormalized task.sessionState, so prefer session.state
  // and only fall back to the task field when there's no live session attached.
  const state = session?.state ?? task.sessionState;
  return (
    <Group gap="snug" wrap="nowrap">
      <KindBadge kind={task.kind} />
      {session?.needsInput && (
        <Badge color="yellow" variant="filled">
          needs you
        </Badge>
      )}
      {state && (
        <Badge color={SESSION_BADGE[state].color} variant="filled">
          {SESSION_BADGE[state].label}
        </Badge>
      )}
      {showStatus && (
        <Badge color={STATUS_COLOR[task.status]} variant="light">
          {task.status}
        </Badge>
      )}
    </Group>
  );
}
