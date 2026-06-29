import { Text, UnstyledButton } from "@mantine/core";

/** A bigger collapse caret for a goal / milestone header. */
export function Caret({
  collapsed,
  onToggle,
  label,
}: { collapsed: boolean; onToggle: () => void; label: string }) {
  return (
    <UnstyledButton onClick={onToggle} title={label} style={{ lineHeight: 1, flexShrink: 0 }}>
      <Text size="xl" c="dimmed" w={18} ta="center" style={{ userSelect: "none" }}>
        {collapsed ? "▸" : "▾"}
      </Text>
    </UnstyledButton>
  );
}
