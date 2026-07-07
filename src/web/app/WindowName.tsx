import { Text, TextInput } from "@mantine/core";
import { useState } from "react";
import { useActiveWindow, useStore } from "../store.ts";

/** The active window's optional name: click to edit. Unlike EditableText, an
 *  unnamed window starts the draft EMPTY (the "unnamed" placeholder is a label,
 *  not text you should have to delete), and committing empty clears the name —
 *  back to identified-by-repo-set, like a browser window. Reads its own window +
 *  setter from the store (selectors, not drilled props), like the settings
 *  controls do. */
export function WindowName() {
  const win = useActiveWindow();
  const renameWindow = useStore((s) => s.renameWindow);
  const [draft, setDraft] = useState<string | null>(null); // null = not editing
  if (!win) return null;
  if (draft != null) {
    const commit = () => {
      renameWindow(win.id, draft.trim() || null);
      setDraft(null);
    };
    return (
      <TextInput
        size="xs"
        variant="filled"
        autoFocus
        value={draft}
        placeholder="name this window"
        onChange={(e) => setDraft(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") setDraft(null);
        }}
        style={{ width: 140 }}
      />
    );
  }
  return (
    <Text
      size="xs"
      c={win.name ? undefined : "dimmed"}
      truncate
      title="Click to name this window"
      style={{ cursor: "text", maxWidth: 180 }}
      onClick={() => setDraft(win.name ?? "")}
    >
      {win.name ?? "unnamed"}
    </Text>
  );
}
