// straitjacket-allow-file:duplication  the <FilterBar> call site resembles TasksPane's,
// but FilterBar is already the shared component — the two just bind different filter types
// (SessionFilter vs TaskFilter); a wrapper would re-thread every prop for nothing.
import type { ComboboxData } from "@mantine/core";
import { Badge, Box, Group, Stack, Switch, Text, Tooltip } from "@mantine/core";
import type { DockviewPanelApi } from "dockview-react";
import { useState } from "react";
import type { Session } from "../../../server/schema.ts";
import { SessionKind } from "../../../shared/types.ts";
import { usePaneScroll } from "../../pane-scroll.ts";
import { useFullData } from "../../plan-data.ts";
import { KIND_ICON } from "../../plan-ui";
import { useActiveWindow, useStore } from "../../store.ts";
import { FilterBar } from "../FilterBar.tsx";
import {
  ANY,
  DEFAULT_SESSION_FILTER,
  matchSession,
  parseScope,
  SessionBucket,
  type SessionFilter,
  scopeOptions,
  scopeValue,
  sessionInScope,
} from "../filters.ts";
import { useWindow } from "../use-window.ts";
import { WorkerCard } from "./WorkerCard.tsx";

// The status buckets the operator filters on (default Running = live). Values are the
// SessionBucket consts, not literals, so the typed-string lint stays happy.
const STATUS_DATA: ComboboxData = [
  { value: ANY, label: "Any status" },
  { value: SessionBucket.Live, label: "Running" },
  { value: SessionBucket.Landed, label: "Landed" },
  { value: SessionBucket.Aborted, label: "Stopped" },
];

// The Sessions pane is the full record of every RUN of work — live AND historical.
// The unit is the SESSION (one worker = one card; a worker can carry several tasks via
// the session_tasks join), rendered the same whether it's running now or landed/stopped
// weeks ago: the header shows kind + outcome (the state badge), the task(s), their PRs
// and the final agent status. A session that left the old Active monitor used to vanish
// from view entirely — it lives here now. A search + filter strip (FilterBar) slices the
// list; it opens to running (DEFAULT_SESSION_FILTER) so the pane comes up like the old
// Active monitor, and widens to landed/stopped history on demand. Order: live first
// (needs-you floated up), then newest.

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
  // Opens to running (DEFAULT_SESSION_FILTER) so the pane comes up showing what the old
  // Active monitor did; widen the status filter to browse landed/stopped history.
  const [filter, setFilter] = useState<SessionFilter>(DEFAULT_SESSION_FILTER);
  const set = (patch: Partial<SessionFilter>) => setFilter((f) => ({ ...f, ...patch }));
  const isDefault = JSON.stringify(filter) === JSON.stringify(DEFAULT_SESSION_FILTER);

  // The active window's ambient repo scope, applied UNDER the FilterBar. A session
  // reaches it through its tasks; the header counts describe the scoped list too.
  const scope = useActiveWindow()?.repoIds ?? [];
  const ordered = orderSessions(sessions).filter((s) =>
    sessionInScope(idx.tasksBySession.get(s.id) ?? [], scope),
  );
  const visible = ordered.filter((s) =>
    matchSession(s, idx.tasksBySession.get(s.id) ?? [], idx, filter),
  );
  // Window the (potentially long) history so the DOM stays small; the full list is still
  // live underneath. The filter signature resets the window to the first page.
  const win = useWindow(visible.length, `${JSON.stringify(filter)}:${scope.join(",")}`, scroll.ref);
  const shown = visible.slice(0, win.limit);
  const live = ordered.filter((s) => s.archivedAt == null);
  const cloudCount = live.filter((s) => s.kind === SessionKind.Remote).length;
  const localCount = live.filter((s) => s.kind === SessionKind.Local).length;
  const exeCount = live.filter((s) => s.kind === SessionKind.Exe).length;
  const RemoteIcon = KIND_ICON[SessionKind.Remote];
  const LocalIcon = KIND_ICON[SessionKind.Local];
  const ExeIcon = KIND_ICON[SessionKind.Exe];

  return (
    <Box
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: "var(--pm-pane-bg)",
      }}
    >
      <Stack gap="cozy" px="md" py="cozy" style={{ flex: "0 0 auto" }}>
        <Group justify="space-between">
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
            <Badge
              size="sm"
              variant="light"
              color={exeCount > 0 ? "blue" : "gray"}
              title="live exe.dev sessions"
              leftSection={<ExeIcon size={12} />}
            >
              {exeCount}
            </Badge>
            <Text size="xs" c="dimmed">
              {visible.length} shown
            </Text>
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
        <FilterBar
          search={filter.search}
          onSearch={(v) => set({ search: v })}
          searchPlaceholder="session/task id or title"
          statusData={STATUS_DATA}
          status={filter.status}
          onStatus={(v) => set({ status: v as SessionFilter["status"] })}
          env={filter.kind}
          onEnv={(v) => set({ kind: v as SessionFilter["kind"] })}
          scopeData={scopeOptions(idx)}
          scope={scopeValue(filter)}
          onScope={(v) => set(parseScope(v))}
          starred={filter.starred}
          onStarred={(v) => set({ starred: v })}
          onReset={() => setFilter(DEFAULT_SESSION_FILTER)}
          isDefault={isDefault}
        />
      </Stack>

      <Box
        ref={scroll.ref}
        onScroll={scroll.onScroll}
        data-pm-scroll="sessions" // lint-allow-string: dockview pane id, not an enum value
        style={{ flex: 1, overflowY: "auto" }}
        px="md"
        py="xs"
      >
        {visible.length === 0 ? (
          <Text c="dimmed" size="sm" py="lg">
            {ordered.length === 0
              ? "No sessions yet. Launch a task from the Tasks pane (Start local / Dispatch remote) and it shows up here — and stays after it lands, as history."
              : "No sessions match these filters."}
          </Text>
        ) : (
          <Stack gap="xs">
            {shown.map((s) => (
              <WorkerCard
                key={s.id}
                session={s}
                tasks={idx.tasksBySession.get(s.id) ?? []}
                idx={idx}
                showContext
              />
            ))}
            {win.hasMore && (
              <div ref={win.sentinelRef}>
                <Text c="dimmed" size="xs" ta="center" py="sm">
                  loading more… ({shown.length} of {visible.length})
                </Text>
              </div>
            )}
          </Stack>
        )}
      </Box>
    </Box>
  );
}
