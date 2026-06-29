import { Button } from "@mantine/core";

// A top-bar button that opens (or focuses) a pane. The whole top bar is now just
// these launchers — one per pane type — so summoning any pane is the same gesture.
// `subtle` + gray reads as a clean nav strip: text by default, a faint wash on hover.
export function PaneButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button size="compact-sm" variant="subtle" color="gray" fw={600} onClick={onClick}>
      {label}
    </Button>
  );
}
