import { Button } from "@mantine/core";

// A top-bar button that opens (or focuses) a pane. The whole top bar is now just
// these launchers — one per pane type — so summoning any pane is the same gesture.
export function PaneButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button size="compact-xs" variant="default" onClick={onClick}>
      {label}
    </Button>
  );
}
