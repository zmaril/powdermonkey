import { Button, Popover, Stack, Text, Textarea } from "@mantine/core";
import { type ReactNode, useState } from "react";

/** A launch button (laptop/cloud + play) that opens a popover to attach an optional
 *  note for this run before launching — the note rides into the worker's prompt. Just
 *  hit the confirm (or Cmd/Ctrl+Enter) to launch with no note. [prototype] */
export function LaunchButton({
  icon,
  label,
  color,
  loading,
  disabled,
  onRun,
}: {
  icon: ReactNode;
  label: string;
  color?: string;
  loading: boolean;
  disabled: boolean;
  onRun: (comment: string) => void;
}) {
  const [opened, setOpened] = useState(false);
  const [note, setNote] = useState("");
  const run = () => {
    onRun(note);
    setNote("");
    setOpened(false);
  };
  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      position="bottom-start"
      width={280}
      withArrow
      shadow="md"
      trapFocus
    >
      <Popover.Target>
        <Button
          size="compact-xs"
          variant="light"
          color={color}
          title={label}
          loading={loading}
          disabled={disabled}
          onClick={(e) => {
            e.stopPropagation();
            setOpened((o) => !o);
          }}
        >
          {icon}
        </Button>
      </Popover.Target>
      <Popover.Dropdown onClick={(e) => e.stopPropagation()}>
        <Stack gap="xs">
          <Text size="xs" fw={600}>
            {label}
          </Text>
          <Textarea
            value={note}
            onChange={(e) => setNote(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run();
            }}
            placeholder="optional note for this run…"
            autosize
            minRows={2}
            maxRows={6}
            size="xs"
            autoFocus
          />
          <Button size="xs" color={color} onClick={run}>
            {label}
          </Button>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
