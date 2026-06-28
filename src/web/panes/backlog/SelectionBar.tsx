import { Button, Group, Text } from "@mantine/core";
import { useState } from "react";
import { useStore } from "../../store.ts";

/** The batch action bar, shown while one or more tasks are selected. Launches the
 *  whole selection as ONE session (local or remote) and then clears the selection.
 *  Order follows the rendered backlog so the first card is the primary task. */
export function SelectionBar({ ids, clear }: { ids: number[]; clear: () => void }) {
  const { startLocalMany, dispatchMany } = useStore();
  // Track WHICH batch action is in flight, so the clicked button shows its own
  // spinner (matching the per-task Dispatch remote / Start local loading state).
  const [running, setRunning] = useState<"local" | "remote" | null>(null);
  const busy = running !== null;

  const run = async (kind: "local" | "remote") => {
    if (busy || ids.length === 0) return;
    setRunning(kind);
    try {
      if (kind === "local") await startLocalMany(ids);
      else await dispatchMany(ids);
      clear();
    } finally {
      setRunning(null);
    }
  };

  return (
    <Group
      justify="space-between"
      px="md"
      py={8}
      style={{ flex: "0 0 auto", borderTop: "1px solid #2c2e33", background: "#25262b" }}
    >
      <Text size="sm" fw={600}>
        {ids.length} selected
      </Text>
      <Group gap="xs">
        <Button
          size="compact-xs"
          variant="light"
          loading={running === "local"}
          disabled={busy}
          onClick={() => run("local")}
        >
          Start local
        </Button>
        <Button
          size="compact-xs"
          variant="subtle"
          color="gray"
          loading={running === "remote"}
          disabled={busy}
          onClick={() => run("remote")}
        >
          Dispatch remote
        </Button>
        <Button size="compact-xs" variant="subtle" color="gray" disabled={busy} onClick={clear}>
          clear
        </Button>
      </Group>
    </Group>
  );
}
