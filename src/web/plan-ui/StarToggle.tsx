import { Text, UnstyledButton } from "@mantine/core";
import { IconStar, IconStarFilled } from "@tabler/icons-react";
import type { Task } from "../../server/schema.ts";
import { useStore } from "../store.ts";

/** A click-to-toggle priority star. Starred tasks sort to the top of their group
 *  (active / backlog). `flexShrink: 0` so it never collapses in a tight row. */
export function StarToggle({ task }: { task: Task }) {
  const toggleStar = useStore((s) => s.toggleStar);
  return (
    <UnstyledButton
      aria-label={task.starred ? "Unstar task" : "Star task"}
      title={task.starred ? "Unstar" : "Star — sorts to the top of its group"}
      onClick={(e) => {
        e.stopPropagation();
        toggleStar(task.id, !task.starred);
      }}
      style={{ flexShrink: 0, lineHeight: 1 }}
    >
      <Text span c={task.starred ? "yellow" : "dimmed"} style={{ display: "inline-flex" }}>
        {task.starred ? <IconStarFilled size={14} /> : <IconStar size={14} />}
      </Text>
    </UnstyledButton>
  );
}
