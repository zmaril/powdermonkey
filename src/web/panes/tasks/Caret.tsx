import { Text, UnstyledButton } from "@mantine/core";
import { IconChevronDown, IconChevronRight } from "@tabler/icons-react";

/** A bigger collapse caret for a goal / milestone header. */
export function Caret({
  collapsed,
  onToggle,
  label,
}: {
  collapsed: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <UnstyledButton onClick={onToggle} title={label} style={{ lineHeight: 1, flexShrink: 0 }}>
      <Text
        c="dimmed"
        w={18}
        ta="center"
        style={{ display: "inline-flex", justifyContent: "center" }}
      >
        {collapsed ? <IconChevronRight size={18} /> : <IconChevronDown size={18} />}
      </Text>
    </UnstyledButton>
  );
}
