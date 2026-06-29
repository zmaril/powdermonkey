import { Button, Group, Text } from "@mantine/core";
import { TaskActions } from "./TaskActions.tsx";

/** The batch action bar, shown while one or more tasks are selected: bigger and lit
 *  with an electric-blue edge so it's unmissable. Same action cluster as a card, but
 *  applied to the whole selection as ONE launch. */
export function SelectionBar({ ids, clear }: { ids: number[]; clear: () => void }) {
  return (
    <Group
      justify="space-between"
      px="lg"
      py="md"
      style={{
        flex: "0 0 auto",
        borderTop: "2px solid var(--mantine-color-blue-5)",
        background: "#1b2434",
        boxShadow: "0 -4px 22px 2px rgba(59,130,246,0.5)",
      }}
    >
      <Text size="md" fw={700}>
        {ids.length} selected
      </Text>
      <Group gap="sm" wrap="nowrap">
        <TaskActions ids={ids} onDone={clear} />
        <Button size="compact-sm" variant="subtle" color="gray" onClick={clear}>
          clear
        </Button>
      </Group>
    </Group>
  );
}
