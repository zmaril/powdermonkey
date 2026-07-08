import { Button, Group, Text } from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";
import { TaskActions } from "./TaskActions.tsx";

// Shown when the selection spans repos: one session is one repo, so the batch can't be
// launched together (closing it is still fine). Mirrors the server's CROSS_REPO_ERROR.
const CROSS_REPO_REASON =
  "These tasks target different repos. A session runs one repo, so launch each repo's tasks separately — or author cross-repo work with the fan-out.";

/** The batch action bar, shown while one or more tasks are selected: bigger and lit
 *  with an electric-blue edge so it's unmissable. Same action cluster as a card, but
 *  applied to the whole selection as ONE launch. `crossRepo` disables the launch buttons
 *  (and shows why) when the selection spans repos — the client-side twin of the server's
 *  cross-repo dispatch guard. */
export function SelectionBar({
  ids,
  clear,
  crossRepo = false,
}: {
  ids: number[];
  clear: () => void;
  crossRepo?: boolean;
}) {
  return (
    <Group
      justify="space-between"
      px="lg"
      py="md"
      style={{
        flex: "0 0 auto",
        borderTop: "2px solid var(--mantine-color-blue-5)",
        background: "var(--pm-surface)",
        boxShadow: "0 -4px 22px 2px var(--pm-selection-glow)",
      }}
    >
      <Group gap="sm" wrap="nowrap">
        <Text size="md" fw={700}>
          {ids.length} selected
        </Text>
        {crossRepo && (
          <Group gap="tight" wrap="nowrap" c="yellow.6">
            <IconAlertTriangle size={16} />
            <Text size="xs" fw={600}>
              spans repos — can't launch together
            </Text>
          </Group>
        )}
      </Group>
      <Group gap="sm" wrap="nowrap">
        <TaskActions
          ids={ids}
          onDone={clear}
          blockedReason={crossRepo ? CROSS_REPO_REASON : undefined}
        />
        <Button size="compact-sm" variant="subtle" color="gray" onClick={clear}>
          clear
        </Button>
      </Group>
    </Group>
  );
}
