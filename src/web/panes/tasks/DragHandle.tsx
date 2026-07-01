import { Text } from "@mantine/core";

/** The grab affordance (⠿) for a draggable milestone header or task card. Only this
 *  element starts a drag — `props` is dnd-kit's attribute + listener bag — so the rest
 *  of the row stays clickable, selectable, and editable. */
export function DragHandle(props: Record<string, unknown>) {
  return (
    <Text
      span
      c="dimmed"
      // biome-ignore lint/suspicious/noExplicitAny: dnd-kit listener/attribute bag.
      {...(props as any)}
      style={{
        cursor: "grab",
        userSelect: "none",
        lineHeight: 1,
        touchAction: "none",
        flexShrink: 0,
      }}
      title="Drag to reorder"
    >
      ⠿
    </Text>
  );
}
