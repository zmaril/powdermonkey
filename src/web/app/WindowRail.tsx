import { ActionIcon, Stack, Tooltip, UnstyledButton } from "@mantine/core";
import { IconPlus, IconX } from "@tabler/icons-react";
import { useLiveQuery } from "@tanstack/react-db";
import { reposCollection } from "../collections.ts";
import { useStore } from "../store.ts";
import { openNewWindow } from "../window-bridge.ts";
import { type PmWindow, windowLabel } from "../windows.ts";
import { RailGlyph } from "./RailGlyph.tsx";

// The window rail (docs/windows.md): a Slack-style switcher, always open on the left
// edge — one entry per window, click to swap the whole dock (layout + repo scope) to
// it. An entry reads as its repo set: a stack of identity-colored dots (the same
// theme-hashed swatches the repo badges use), a hollow ring for an unscoped window.
// `+` opens a fresh unscoped window (scope it from the tab strip); the active entry
// carries the close ✕ — you close the window you're looking at, Firefox-style, and
// closing the last one just hands you a fresh empty view (the list is never empty).

export function WindowRail() {
  const windows = useStore((s) => s.windows);
  const activeWindowId = useStore((s) => s.activeWindowId);
  const switchWindow = useStore((s) => s.switchWindow);
  const removeWindow = useStore((s) => s.removeWindow);
  const repos = useLiveQuery(() => reposCollection);
  const byId = new Map((repos.data ?? []).map((r) => [r.id, r]));
  const label = (w: PmWindow) => windowLabel(w, (id) => byId.get(id)?.slug);

  return (
    <Stack
      gap="tight"
      px="hair"
      py="xs"
      align="center"
      style={{
        flex: "0 0 auto",
        width: 44,
        borderRight: "1px solid var(--pm-hairline)",
        background: "var(--pm-tab-strip)",
        overflowY: "auto",
      }}
    >
      {windows.map((w) => {
        const active = w.id === activeWindowId;
        return (
          <Stack key={w.id} gap={0} align="center">
            <Tooltip label={label(w)} position="right" withArrow>
              <UnstyledButton
                onClick={() => switchWindow(w.id)}
                aria-label={`Switch to window: ${label(w)}`}
                aria-current={active || undefined}
                style={{
                  width: 32,
                  height: 32,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: "var(--mantine-radius-md)",
                  border: active ? "2px solid var(--pm-accent)" : "2px solid var(--pm-hairline)",
                  background: active ? "var(--pm-pane-bg)" : "transparent",
                }}
              >
                <RailGlyph win={w} byId={byId} />
              </UnstyledButton>
            </Tooltip>
            {active && (
              <ActionIcon
                size="xs"
                variant="subtle"
                color="gray"
                onClick={() => removeWindow(w.id)}
                aria-label="Close this window"
                title="Close this window"
              >
                <IconX size={10} />
              </ActionIcon>
            )}
          </Stack>
        );
      })}
      <Tooltip label="New window" position="right" withArrow>
        <ActionIcon
          size="md"
          variant="subtle"
          color="gray"
          onClick={() => openNewWindow()}
          aria-label="New window"
        >
          <IconPlus size={15} />
        </ActionIcon>
      </Tooltip>
    </Stack>
  );
}
