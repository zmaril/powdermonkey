import { Text, TextInput, Textarea } from "@mantine/core";
import { useState } from "react";

/** Click-to-edit text: shows the value, becomes an input on click, commits on Enter or
 *  blur, cancels on Escape. The seam for inline plan editing — card titles, phase names —
 *  writing straight through the CRUD routes (the synced collection re-renders the value).
 *  `wrap` makes it multi-line: the display wraps instead of truncating, and editing uses
 *  an autosizing textarea (Enter still commits; Shift+Enter for a newline). Stops click
 *  propagation so editing a field never shift-selects the card. */
export function EditableText({
  value,
  onSave,
  fw,
  size = "sm",
  dimmed = false,
  strikethrough = false,
  wrap = false,
  placeholder,
}: {
  value: string;
  onSave: (next: string) => void;
  fw?: number;
  size?: string;
  dimmed?: boolean;
  strikethrough?: boolean;
  wrap?: boolean;
  placeholder?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  const commit = () => {
    const next = draft.trim();
    if (next && next !== value) onSave(next);
    setEditing(false);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      setDraft(value);
      setEditing(false);
    }
  };

  if (editing) {
    const common = {
      value: draft,
      size: "xs" as const,
      variant: "filled" as const,
      autoFocus: true,
      placeholder,
      style: { flex: 1, minWidth: 0 },
      onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
        setDraft(e.currentTarget.value),
      onBlur: commit,
      onKeyDown,
      onClick: (e: React.MouseEvent) => e.stopPropagation(),
    };
    return wrap ? <Textarea {...common} autosize minRows={1} /> : <TextInput {...common} />;
  }
  return (
    <Text
      fw={fw}
      size={size}
      truncate={!wrap}
      c={dimmed ? "dimmed" : undefined}
      td={strikethrough ? "line-through" : undefined}
      title="Click to edit"
      style={{ cursor: "text", ...(wrap ? { wordBreak: "break-word" } : {}) }}
      onClick={(e) => {
        e.stopPropagation();
        setDraft(value);
        setEditing(true);
      }}
    >
      {value}
    </Text>
  );
}
