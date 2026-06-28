import {
  Box,
  Button,
  Card,
  Code,
  CopyButton,
  Group,
  SegmentedControl,
  Stack,
  Text,
  Title,
  UnstyledButton,
} from "@mantine/core";
import type { DockviewPanelApi } from "dockview-react";
import { useState } from "react";
import type { Goal, Milestone, Phase, Task } from "../server/schema.ts";
import { SessionKind, TaskStatus } from "../shared/types.ts";
import { AnimatedList } from "./AnimatedList.tsx";
import { partitionTasks } from "./active.ts";
import { usePaneScroll } from "./pane-scroll.ts";
import { type Indexes, starFirst, usePlanData } from "./plan-data.ts";
import { IdTag, PhaseList, ProgressPill, StarToggle } from "./plan-ui.tsx";
import { useStore } from "./store.ts";

// The Backlog pane is the launchpad — everything to-be-worked (not active),
// grouped goal → milestone as cards (or one flat star-first list). Every card
// carries the same action cluster (TaskActions): launch it 💻/☁️ or close it
// (DONE / WONTDO). Shift-click a card to add it to a multi-selection; while a
// selection is live the per-card actions hide and one batch bar drives the whole
// set as ONE launch — so it's clear they move together. Goals and milestones have
// carets to collapse them.

// Electric-blue glow on a selected card / the batch bar, so the live selection pops.
const SELECTED_SHADOW = "0 0 0 2px var(--mantine-color-blue-5), 0 0 16px 2px rgba(59,130,246,0.55)";

// Multi-select wiring threaded down to each card: whether a task is checked, a
// toggle, and whether ANY selection is live (so cards can hide their own actions).
type Selection = { selected: Set<number>; toggle: (id: number) => void; active: boolean };

/** A bigger collapse caret for a goal / milestone header. */
function Caret({
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

/** The shared action cluster for a backlog task (or a whole multi-selection): launch
 *  local 💻▶ / remote ☁️▶, or close it (DONE / WONTDO). Works on one or many ids — the
 *  solo card passes `[task.id]`, the batch bar passes the selection — so the buttons
 *  look and behave identically in both. `onDone` lets the batch bar clear the selection
 *  after an action. Clicks stop propagation so they don't shift-select the card. */
function TaskActions({ ids, onDone }: { ids: number[]; onDone?: () => void }) {
  const { startLocalMany, dispatchMany, completeTask, cancelTask } = useStore();
  const [running, setRunning] = useState<SessionKind | null>(null);
  const busy = running !== null;

  const launch = async (kind: SessionKind) => {
    if (busy || ids.length === 0) return;
    setRunning(kind);
    try {
      if (kind === SessionKind.Local) await startLocalMany(ids);
      else await dispatchMany(ids);
      onDone?.();
    } finally {
      setRunning(null);
    }
  };
  const markDone = () => {
    for (const id of ids) completeTask(id);
    onDone?.();
  };
  const wontDo = () => {
    const msg =
      ids.length > 1
        ? `Close ${ids.length} tasks as won't-do? They move to the archive as cancelled.`
        : "Close this task as won't-do? It moves to the archive as cancelled.";
    if (window.confirm(msg)) {
      for (const id of ids) cancelTask(id);
      onDone?.();
    }
  };

  return (
    <Group gap="xs" wrap="nowrap" style={{ flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
      <Button
        size="compact-xs"
        variant="light"
        title="Start local"
        loading={running === SessionKind.Local}
        disabled={busy}
        onClick={() => launch(SessionKind.Local)}
      >
        💻 ▶
      </Button>
      <Button
        size="compact-xs"
        variant="light"
        color="cyan"
        title="Dispatch remote"
        loading={running === SessionKind.Remote}
        disabled={busy}
        onClick={() => launch(SessionKind.Remote)}
      >
        ☁️ ▶
      </Button>
      <Button
        size="compact-xs"
        variant="light"
        color="orange"
        title="Mark this task done by hand"
        onClick={markDone}
      >
        DONE
      </Button>
      <Button
        size="compact-xs"
        variant="light"
        color="red"
        title="Close as won't-do (archived, not counted as done)"
        onClick={wontDo}
      >
        WONTDO
      </Button>
    </Group>
  );
}

/** One backlog task card. Star + id + title on the left, actions on the right (hidden
 *  while a selection is live, so the batch bar owns them). Shift-click anywhere selects
 *  it (mousedown preventDefault stops the stray text-highlight); selected cards get an
 *  electric-blue glow. */
function BacklogCard({
  task,
  phases,
  selection,
}: {
  task: Task;
  phases: Phase[];
  selection: Selection;
}) {
  const checked = selection.selected.has(task.id);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: shift-click is additive over the explicit buttons.
    <Card
      withBorder
      radius="md"
      padding="sm"
      bg={checked ? "dark.5" : undefined}
      style={{ boxShadow: checked ? SELECTED_SHADOW : undefined }}
      onMouseDown={(e) => {
        if (e.shiftKey) e.preventDefault();
      }}
      onClick={(e) => {
        if (e.shiftKey) {
          e.preventDefault();
          selection.toggle(task.id);
        }
      }}
    >
      <Group justify="space-between" wrap="nowrap" mb={6}>
        <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
          <StarToggle task={task} />
          <IdTag prefix="t" id={task.id} />
          <Text fw={500} truncate>
            {task.title}
          </Text>
        </Group>
        {!selection.active && <TaskActions ids={[task.id]} />}
      </Group>
      <PhaseList phases={phases} />
    </Card>
  );
}

/** A milestone and its backlog cards, with a caret to collapse the lot. */
function MilestoneGroup({
  milestone,
  tasks,
  idx,
  selection,
}: {
  milestone: Milestone;
  tasks: Task[];
  idx: Indexes;
  selection: Selection;
}) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <Stack gap="xs" ml={20}>
      <Group gap={6} wrap="nowrap" align="center">
        <Caret
          collapsed={collapsed}
          onToggle={() => setCollapsed((c) => !c)}
          label={collapsed ? "Expand milestone" : "Collapse milestone"}
        />
        <IdTag prefix="m" id={milestone.id} />
        <Title order={5}>{milestone.title}</Title>
      </Group>
      {!collapsed && (
        <AnimatedList gap={10}>
          {tasks.map((t) => (
            <BacklogCard
              key={t.id}
              task={t}
              phases={idx.phasesByTask.get(t.id) ?? []}
              selection={selection}
            />
          ))}
        </AnimatedList>
      )}
    </Stack>
  );
}

/** A goal and its milestones. A caret collapses the whole goal. Milestones with no
 *  backlog tasks are skipped; a goal with no remaining backlog renders nothing. */
function GoalGroup({
  goal,
  idx,
  backlog,
  selection,
}: {
  goal: Goal;
  idx: Indexes;
  backlog: Set<number>;
  selection: Selection;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const milestones = (idx.milestonesByGoal.get(goal.id) ?? [])
    .map((m) => ({
      m,
      tasks: starFirst((idx.tasksByMilestone.get(m.id) ?? []).filter((t) => backlog.has(t.id))),
    }))
    .filter(({ tasks }) => tasks.length > 0);

  if (milestones.length === 0) return null;

  return (
    <Stack gap="md">
      <div>
        <Group gap={8} wrap="nowrap" align="center">
          <Caret
            collapsed={collapsed}
            onToggle={() => setCollapsed((c) => !c)}
            label={collapsed ? "Expand goal" : "Collapse goal"}
          />
          <IdTag prefix="g" id={goal.id} />
          <Title order={3}>{goal.title}</Title>
        </Group>
        {!collapsed && goal.objective && (
          <Text c="dimmed" size="sm" mt={4} ml={26}>
            {goal.objective}
          </Text>
        )}
      </div>

      {!collapsed &&
        milestones.map(({ m, tasks }) => (
          <MilestoneGroup key={m.id} milestone={m} tasks={tasks} idx={idx} selection={selection} />
        ))}
    </Stack>
  );
}

/** One dense backlog row for the flat view: star · id · title · context on the left,
 *  the same actions on the right. Shift-click selects; selected rows get the glow. */
function BacklogRow({
  task,
  idx,
  context,
  selection,
}: {
  task: Task;
  idx: Indexes;
  context?: string;
  selection: Selection;
}) {
  const phases = idx.phasesByTask.get(task.id) ?? [];
  const checked = selection.selected.has(task.id);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: shift-click is additive over the explicit buttons.
    <Box
      px="sm"
      py={8}
      style={{
        borderBottom: "1px solid #2c2e33",
        background: checked ? "#25262b" : undefined,
        boxShadow: checked ? SELECTED_SHADOW : undefined,
      }}
      onMouseDown={(e) => {
        if (e.shiftKey) e.preventDefault();
      }}
      onClick={(e) => {
        if (e.shiftKey) {
          e.preventDefault();
          selection.toggle(task.id);
        }
      }}
    >
      <Group gap="sm" wrap="nowrap" align="center">
        <StarToggle task={task} />
        <Box style={{ flex: 1, minWidth: 0 }}>
          <Group gap={6} wrap="nowrap">
            <IdTag prefix="t" id={task.id} />
            <Text size="sm" fw={500} truncate>
              {task.title}
            </Text>
          </Group>
          {context && (
            <Text size="xs" c="dimmed" truncate>
              {context}
            </Text>
          )}
        </Box>
        {phases.length > 0 && <ProgressPill phases={phases} />}
        {!selection.active && <TaskActions ids={[task.id]} />}
      </Group>
    </Box>
  );
}

/** Flat backlog: every to-be-worked task in one dense list, starred first, each
 *  carrying its goal › milestone context. The Backlog counterpart to Active's flat. */
function FlatView({
  tasks,
  idx,
  selection,
}: { tasks: Task[]; idx: Indexes; selection: Selection }) {
  return (
    <AnimatedList gap={0}>
      {starFirst(tasks).map((t) => {
        const m = idx.milestoneById.get(t.milestoneId);
        const g = m ? idx.goalById.get(m.goalId) : undefined;
        const context = [g?.title, m?.title].filter(Boolean).join(" › ");
        return <BacklogRow key={t.id} task={t} idx={idx} context={context} selection={selection} />;
      })}
    </AnimatedList>
  );
}

/** The batch action bar, shown while one or more tasks are selected: bigger and lit
 *  with an electric-blue edge so it's unmissable. Same action cluster as a card, but
 *  applied to the whole selection as ONE launch. */
function SelectionBar({ ids, clear }: { ids: number[]; clear: () => void }) {
  return (
    <Group
      justify="space-between"
      px="lg"
      py="md"
      style={{
        flex: "0 0 auto",
        borderTop: "2px solid var(--mantine-color-blue-5)",
        background: "#1b2434",
        boxShadow: "0 -4px 22px 2px rgba(59,130,246,0.5)",
      }}
    >
      <Text size="md" fw={700}>
        {ids.length} selected
      </Text>
      <Group gap="sm" wrap="nowrap">
        <TaskActions ids={ids} onDone={clear} />
        <Button size="compact-sm" variant="subtle" color="gray" onClick={clear}>
          clear
        </Button>
      </Group>
    </Group>
  );
}

/** The prompt panel shown after Start local — paste it into the worktree session. */
function StartPanel() {
  const { lastStart, dismissStart } = useStore();
  if (!lastStart) return null;
  return (
    <Card withBorder radius="md" mb="md" bg="dark.6">
      <Group justify="space-between" mb="xs">
        <Text fw={600}>Local session ready · {lastStart.branch}</Text>
        <Button size="compact-xs" variant="subtle" color="gray" onClick={dismissStart}>
          dismiss
        </Button>
      </Group>
      <Text size="sm" c="dimmed">
        Worktree: <Code>{lastStart.worktreePath}</Code>
      </Text>
      <CopyButton value={lastStart.prompt}>
        {({ copied, copy }) => (
          <Button size="compact-xs" mt="xs" variant="light" onClick={copy}>
            {copied ? "copied" : "copy prompt"}
          </Button>
        )}
      </CopyButton>
    </Card>
  );
}

type View = "flat" | "grouped";

export function BacklogPane({ api }: { api?: DockviewPanelApi }) {
  const { idx, activeIds, loading } = usePlanData();
  const [view, setView] = useState<View>("grouped");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const scroll = usePaneScroll("backlog", api);

  // Backlog = everything to-be-worked: not active (no live session) and not merged.
  const allTasks = [...idx.tasksByMilestone.values()].flat();
  const { backlog: backlogList } = partitionTasks(allTasks, activeIds);
  const backlogTasks = backlogList.filter((t) => t.status !== TaskStatus.Merged);
  const backlog = new Set(backlogTasks.map((t) => t.id));
  const goals = [...idx.goals].sort((a, b) => a.id - b.id);

  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const selection: Selection = { selected, toggle, active: selected.size > 0 };

  // The launch order is the rendered backlog order (goal → milestone → position),
  // so the first selected card becomes the primary task of the shared session. Drop
  // any selected ids that are no longer in the backlog (e.g. just launched).
  const selectedIds = backlogTasks.map((t) => t.id).filter((id) => selected.has(id));

  return (
    <Box
      style={{ height: "100%", display: "flex", flexDirection: "column", background: "#1a1b1e" }}
    >
      <Group justify="space-between" px="md" py={8} style={{ flex: "0 0 auto" }}>
        <Group gap={8}>
          <Text size="xs" c="dimmed" fw={700} style={{ letterSpacing: 0.5 }}>
            BACKLOG
          </Text>
          {loading && (
            <Text size="xs" c="dimmed">
              loading…
            </Text>
          )}
        </Group>
        <SegmentedControl
          size="xs"
          value={view}
          onChange={(v) => setView(v as View)}
          data={[
            { label: "Flat", value: "flat" },
            { label: "Grouped", value: "grouped" },
          ]}
        />
      </Group>

      <Box
        ref={scroll.ref}
        onScroll={scroll.onScroll}
        style={{ flex: 1, overflowY: "auto" }}
        px={view === "grouped" ? "md" : 0}
        py={4}
      >
        <Box px={view === "grouped" ? 0 : "md"}>
          <StartPanel />
        </Box>
        {goals.length === 0 ? (
          <Text c="dimmed" size="sm" px="md" py="lg">
            No plan loaded. POST one to /plan.
          </Text>
        ) : view === "flat" ? (
          backlogTasks.length === 0 ? (
            <Text c="dimmed" size="sm" px="md" py="lg">
              Backlog is empty — every task is active or done.
            </Text>
          ) : (
            <FlatView tasks={backlogTasks} idx={idx} selection={selection} />
          )
        ) : (
          <Stack gap="xl">
            {goals.map((g) => (
              <GoalGroup key={g.id} goal={g} idx={idx} backlog={backlog} selection={selection} />
            ))}
          </Stack>
        )}
      </Box>

      {selectedIds.length > 0 && (
        <SelectionBar ids={selectedIds} clear={() => setSelected(new Set())} />
      )}
    </Box>
  );
}
