import { Text } from "@mantine/core";

/** A tiny uppercase column label (Tasks / PRs) for the worker card body. */
export function ColumnLabel({ children }: { children: string }) {
  return (
    <Text size="xs" c="dimmed" fw={700} tt="uppercase" style={{ letterSpacing: 0.5 }}>
      {children}
    </Text>
  );
}
