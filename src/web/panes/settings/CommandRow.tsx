import { Button, Code, CopyButton, Group, Text } from "@mantine/core";

// One command + a copy button. The shell can't reach into the operator's terminal
// to attach for them — all the UI can do is hand over the exact line to paste.
export function CommandRow({ cmd, hint }: { cmd: string; hint: string }) {
  return (
    <div>
      <Group gap="snug" wrap="nowrap" justify="space-between">
        <Code style={{ fontSize: "0.75rem" }}>{cmd}</Code>
        <CopyButton value={cmd}>
          {({ copied, copy }) => (
            <Button
              size="compact-xs"
              variant={copied ? "light" : "default"}
              color={copied ? "teal" : undefined}
              onClick={copy}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          )}
        </CopyButton>
      </Group>
      <Text size="xs" c="dimmed">
        {hint}
      </Text>
    </div>
  );
}
