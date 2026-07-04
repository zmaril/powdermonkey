import { Group, type MantineSpacing, Stack, Text } from "@mantine/core";
import type { ReactNode } from "react";

// The chrome every simple pane shares: a full-height column with a dimmed all-caps
// label header and a scrolling body. About / Help / Settings all render into this,
// so the surface treatment (background, header type, scroll behaviour) has one home.
export function PaneShell({
  title,
  bodyGap = "md",
  bodyMaxWidth,
  children,
}: {
  title: string;
  /** Gap between body children. Defaults to "md". */
  bodyGap?: MantineSpacing;
  /** Cap the body width (prose panes use 620); omit for a full-width body. */
  bodyMaxWidth?: number;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        height: "100%",
        background: "var(--pm-pane-bg)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <Group px="md" py="cozy" style={{ flex: "0 0 auto" }}>
        <Text size="xs" c="dimmed" fw={700} style={{ letterSpacing: 0.5 }}>
          {title}
        </Text>
      </Group>
      <Stack
        gap={bodyGap}
        px="md"
        pb="md"
        maw={bodyMaxWidth}
        style={{ flex: 1, minHeight: 0, overflowY: "auto" }}
      >
        {children}
      </Stack>
    </div>
  );
}
