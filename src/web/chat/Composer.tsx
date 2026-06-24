// Shared composer (Claude-style): a rounded input with a bottom action row.
// Headless assistant-ui behavior, Mantine chrome.

import { ComposerPrimitive } from "@assistant-ui/react";
import { ActionIcon, Group, Menu, Text, UnstyledButton } from "@mantine/core";

export function Composer() {
  return (
    <ComposerPrimitive.Root
      style={{
        border: "1px solid var(--mantine-color-dark-4)",
        borderRadius: 16,
        background: "var(--mantine-color-dark-6)",
        padding: 10,
        boxShadow: "0 1px 8px rgba(0,0,0,0.25)",
      }}
    >
      <ComposerPrimitive.Input
        autoFocus
        rows={1}
        placeholder="Message PowderMonkey…"
        style={{
          width: "100%",
          resize: "none",
          border: "none",
          outline: "none",
          background: "transparent",
          color: "var(--mantine-color-gray-0)",
          fontSize: 15,
          fontFamily: "inherit",
          padding: "6px 6px 10px",
        }}
      />
      <Group justify="space-between" align="center" gap="xs">
        <ActionIcon variant="subtle" color="gray" radius="xl" size="lg" aria-label="Attach">
          +
        </ActionIcon>
        <Group gap="sm" align="center">
          <Menu position="top-end" withinPortal>
            <Menu.Target>
              <UnstyledButton>
                <Group gap={4} align="center">
                  <Text size="sm" c="dimmed">
                    Opus 4.8
                  </Text>
                  <Text size="xs" c="dimmed">
                    High ▾
                  </Text>
                </Group>
              </UnstyledButton>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item>Opus 4.8</Menu.Item>
              <Menu.Item>Sonnet 4.6</Menu.Item>
            </Menu.Dropdown>
          </Menu>
          <ComposerPrimitive.Send asChild>
            <ActionIcon variant="filled" color="orange" radius="xl" size="lg" aria-label="Send">
              ↑
            </ActionIcon>
          </ComposerPrimitive.Send>
        </Group>
      </Group>
    </ComposerPrimitive.Root>
  );
}
