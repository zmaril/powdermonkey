import { Group, Text } from "@mantine/core";
import { useActiveWindow, useStore } from "../store.ts";

// The per-window scratchpad (docs/windows.md, vocabulary.md § Scratchpad): throwaway
// thinking for THIS working context. The body lives in the window's device-local
// state — it session-restores with the window and is disposed with it, never synced
// and never read by the supervisor. The durable, supervisor-readable notepad is the
// server-side @notes (the Notes pane). Writes go straight to the store (no server
// round-trip, so no draft/debounce machinery): persist mirrors them to localStorage,
// and the cross-tab merge keeps the copy in the tab you're typing in authoritative.
export function WindowScratchPad() {
  const win = useActiveWindow();
  const setWindowScratch = useStore((s) => s.setWindowScratch);
  if (!win) return null;
  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: "var(--pm-pane-bg)",
      }}
    >
      <Group justify="space-between" px="sm" py="snug" style={{ flex: "0 0 auto" }}>
        <Text size="xs" c="dimmed" fw={700} style={{ letterSpacing: 0.5 }}>
          SCRATCH
        </Text>
        <Text size="xs" c="dimmed" title="Device-local; disposed with the window">
          this window
        </Text>
      </Group>
      <textarea
        value={win.scratch}
        onChange={(e) => setWindowScratch(win.id, e.currentTarget.value)}
        placeholder="Throwaway notes for this window…"
        spellCheck={false}
        style={{
          flex: 1,
          width: "100%",
          resize: "none",
          border: "none",
          outline: "none",
          background: "var(--pm-pane-bg)",
          color: "var(--pm-text)",
          padding: "4px 12px 12px",
          fontFamily: "var(--mantine-font-family-monospace)",
          fontSize: "0.8125rem",
          lineHeight: 1.5,
        }}
      />
    </div>
  );
}
