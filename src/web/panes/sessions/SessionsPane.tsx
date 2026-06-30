import { Badge, Box, Group, Stack, Switch, Text, Tooltip } from "@mantine/core";
import type { DockviewPanelApi } from "dockview-react";
import type { Session } from "../../../server/schema.ts";
import { SessionKind } from "../../../shared/types.ts";
import { usePaneScroll } from "../../pane-scroll.ts";
import { useFullData } from "../../plan-data.ts";
import { KIND_ICON } from "../../plan-ui";
import { useStore } from "../../store.ts";
import { WorkerCard } from "./WorkerCard.tsx";

// The Sessions pane is the full record of every RUN of work — live AND historical.
// The unit is the SESSION (one worker = one card; a worker can carry several tasks via
// the session_tasks join), rendered the same whether it's running now or landed/stopped
// weeks ago: the header shows kind + outcome (the state badge), the task(s), their PRs
// and the final agent status. A session that left the old Active monitor used to vanish
// from view entirely — it lives here now. Filtering (default: running) lands in a later
// phase; for now every session shows, live first then newest.

/** Order sessions for the list: live ones first (needs-you floated up), then the rest
 *  newest-first. Stable, pure — no mutation of the input. */
function orderSessions(sessions: Session[]): Session[] {
  return [...sessions].sort((a, b) => {
    const aLive = a.archivedAt == null;
    const bLive = b.archivedAt == null;
    if (aLive !== bLive) return aLive ? -1 : 1;
    if (aLive && a.needsInput !== b.needsInput) return a.needsInput ? -1 : 1;
    return b.id - a.id;
  });
}

export function SessionsPane({ api }: { api?: DockviewPanelApi }) {
  const { idx, sessions } = useFullData();
  const autoRebase = useStore((s) => s.autoRebase);
  const setAutoRebase = useStore((s) => s.setAutoRebase);
  const scroll = usePaneScroll("sessions", api); // lint-allow-string: pane scroll key, not an enum value

  const ordered = orderSessions(sessions);
  const live = ordered.filter((s) => s.archivedAt == null);
  const cloudCount = live.filter((s) => s.kind === SessionKind.Remote).length;
  const localCount = live.filter((s) => s.kind === SessionKind.Local).length;
  const RemoteIcon = KIND_ICON[SessionKind.Remote];
  const LocalIcon = KIND_ICON[SessionKind.Local];

  return (
    <Box
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: "var(--pm-pane-bg)",
      }}
    >
      <Group justify="space-between" px="md" py="cozy" style={{ flex: "0 0 auto" }}>
        <Group gap="cozy">
          <Text size="xs" c="dimmed" fw={700} style={{ letterSpacing: 0.5 }}>
            SESSIONS
          </Text>
          <Badge
            size="sm"
            variant="light"
            color={cloudCount > 0 ? "blue" : "gray"}
            title="live cloud sessions"
            leftSection={<RemoteIcon size={12} />}
          >
            {cloudCount}
          </Badge>
          <Badge
            size="sm"
            variant="light"
            color={localCount > 0 ? "blue" : "gray"}
            title="live local sessions"
            leftSection={<LocalIcon size={12} />}
          >
            {localCount}
          </Badge>
        </Group>
        <Tooltip
          label="Auto-ask @claude to rebase a PR that conflicts with main. Turn off to drive rebases by hand."
          multiline
          w={240}
          withArrow
        >
          <Switch
            size="xs"
            checked={autoRebase}
            onChange={(e) => setAutoRebase(e.currentTarget.checked)}
            label="auto-rebase"
            labelPosition="left"
            styles={{
              label: { fontSize: "var(--mantine-font-size-xs)", color: "var(--pm-dim-text)" },
            }}
          />
        </Tooltip>
      </Group>

      <Box
        ref={scroll.ref}
        onScroll={scroll.onScroll}
        style={{ flex: 1, overflowY: "auto" }}
        px="md"
        py="xs"
      >
        {ordered.length === 0 ? (
          <Text c="dimmed" size="sm" py="lg">
            No sessions yet. Launch a task from the Tasks pane (Start local / Dispatch remote) and
            it shows up here — and stays after it lands, as history.
          </Text>
        ) : (
          <Stack gap="xs">
            {ordered.map((s) => (
              <WorkerCard
                key={s.id}
                session={s}
                tasks={idx.tasksBySession.get(s.id) ?? []}
                idx={idx}
                showContext
              />
            ))}
          </Stack>
        )}
      </Box>
    </Box>
  );
}
