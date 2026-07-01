import { Button } from "@mantine/core";
import { IconArrowDown, IconArrowUp } from "@tabler/icons-react";

// A small pill pinned to the top or bottom edge of the backlog list, pointing toward a
// freshly-added card that's scrolled off-screen in that direction. Click it to jump to the
// nearest such card. The Backlog only renders it while a glowing card is actually off-screen
// that way (see useNewTaskReveal), so it appears with the new task and hides once it's in
// view. Absolutely positioned over the scroll viewport so it stays put as the list scrolls.
export function ScrollIndicator({ dir, onClick }: { dir: "up" | "down"; onClick: () => void }) {
  const Icon = dir === "up" ? IconArrowUp : IconArrowDown;
  return (
    <Button
      size="compact-xs"
      radius="xl"
      color="accent"
      leftSection={<Icon size={14} />}
      onClick={onClick}
      title={dir === "up" ? "Jump to the new task above" : "Jump to the new task below"}
      style={{
        position: "absolute",
        left: "50%",
        transform: "translateX(-50%)",
        [dir === "up" ? "top" : "bottom"]: "var(--mantine-spacing-sm)",
        zIndex: 5,
        boxShadow: "0 2px 8px rgba(0,0,0,0.35)",
      }}
    >
      New task
    </Button>
  );
}
