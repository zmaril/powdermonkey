import { Badge, Group } from "@mantine/core";
import { IconArchive, IconBan, IconCircleCheck } from "@tabler/icons-react";
import type { Task } from "../../../server/schema.ts";
import { TaskStatus } from "../../../shared/types.ts";
import { CompleteTaskControl, STATUS_COLOR, TaskLinks } from "../../plan-ui";

/** The read-only outcome cluster for a terminal or archived task in the Tasks list —
 *  the old Archive row's right side, folded into the card so done/archived no longer
 *  needs its own pane. Merged (finished) and cancelled (won't-do) are named outright;
 *  anything else with archived_at is just "archived". An override decision adds a
 *  provenance chip + reopen (CompleteTaskControl); a reconciled-merged task is read-only.
 *  Replaces the launch action cluster for these tasks — you don't relaunch finished work. */
export function TaskOutcome({ task }: { task: Task }) {
  const merged = task.status === TaskStatus.Merged;
  const cancelled = task.status === TaskStatus.Cancelled;
  const terminal = merged || cancelled;
  const StateIcon = merged ? IconCircleCheck : cancelled ? IconBan : IconArchive;
  const iconColor = merged
    ? "var(--mantine-color-green-5)"
    : cancelled
      ? "var(--mantine-color-red-5)"
      : "var(--mantine-color-dimmed)";
  const stateLabel = merged ? "merged" : cancelled ? "cancelled" : "archived"; // lint-allow-string: tooltip
  return (
    <Group gap="xs" wrap="nowrap" style={{ flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
      <StateIcon size={16} title={stateLabel} color={iconColor} />
      <Badge size="sm" variant="light" color={terminal ? STATUS_COLOR[task.status] : "gray"}>
        {terminal ? task.status : "archived"}
      </Badge>
      {terminal && <CompleteTaskControl task={task} />}
      <TaskLinks task={task} />
    </Group>
  );
}
