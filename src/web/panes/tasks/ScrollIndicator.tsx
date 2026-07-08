import { Button } from "@mantine/core";
import { IconArrowDown, IconArrowUp } from "@tabler/icons-react";

// A small pill pinned to the top or bottom edge of the task list, pointing toward a
// freshly-arrived item that's scrolled off-screen in that direction. Click it to jump to the
// nearest such item. The pane only renders it while a glowing item is actually off-screen
// that way (see useNewTaskReveal / useNewProposalReveal), so it appears with the new item and
// hides once it's in view. Absolutely positioned over the scroll viewport so it stays put as
// the list scrolls.
//
// Two flavours share this one pill: a new TASK (accent) and a new PROPOSAL (teal, matching
// the ghost-card accent). `offset` stacks a second pill clear of the first when both a task
// and a proposal sit off-screen the same way, so they never overlap.
export function ScrollIndicator({
  dir,
  onClick,
  label = "New task",
  color = "accent",
  offset = 0,
}: {
  dir: "up" | "down";
  onClick: () => void;
  /** Pill text + the "Jump to the … above/below" tooltip. */
  label?: string;
  /** Mantine color — `accent` for tasks, `teal` for proposals. */
  color?: string;
  /** Stack index: 0 sits at the edge, 1 sits one pill-height inboard (so a task and a
   *  proposal indicator on the same edge don't overlap). */
  offset?: number;
}) {
  const Icon = dir === "up" ? IconArrowUp : IconArrowDown;
  const edge = dir === "up" ? "top" : "bottom";
  return (
    <Button
      size="compact-xs"
      radius="xl"
      color={color}
      leftSection={<Icon size={14} />}
      onClick={onClick}
      title={`Jump to the ${label.toLowerCase()} ${dir === "up" ? "above" : "below"}`}
      style={{
        position: "absolute",
        left: "50%",
        transform: "translateX(-50%)",
        [edge]: `calc(var(--mantine-spacing-sm) + ${offset} * 2.4rem)`,
        zIndex: 5,
        boxShadow: "0 2px 8px var(--pm-drop-shadow)",
      }}
    >
      {label}
    </Button>
  );
}
