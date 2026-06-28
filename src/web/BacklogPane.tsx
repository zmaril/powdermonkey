import { useAutoAnimate } from "@formkit/auto-animate/react";
import {
  Box,
  Button,
  Card,
  Code,
  CopyButton,
  Group,
  Popover,
  SegmentedControl,
  Stack,
  Text,
  Textarea,
  Title,
  UnstyledButton,
} from "@mantine/core";
import type { DockviewPanelApi } from "dockview-react";
import { useLayoutEffect, useRef, useState } from "react";
import type { Goal, Milestone, Phase, Task } from "../server/schema.ts";
import { SessionKind, TaskStatus } from "../shared/types.ts";
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

// List add/remove/reorder animation — auto-animate handles enter/leave/FLIP (and skips
// the initial mount), so launching a card eases it out and starring re-sorts smoothly
// without the hand-rolled jank. One gentle duration for the whole pane.
const ANIM_OPTS = { duration: 300 } as const;

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

/** A launch button (💻▶ / ☁️▶) that opens a popover to attach an optional note for
 *  this run before launching — the note rides into the worker's prompt. Just hit the
 *  confirm (or ⌘/Ctrl+Enter) to launch with no note. [prototype] */
function LaunchButton({
  icon,
  label,
  color,
  loading,
  disabled,
  onRun,
}: {
  icon: string;
  label: string;
  color?: string;
  loading: boolean;
  disabled: boolean;
  onRun: (comment: string) => void;
}) {
  const [opened, setOpened] = useState(false);
  const [note, setNote] = useState("");
  const run = () => {
    onRun(note);
    setNote("");
    setOpened(false);
  };
  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      position="bottom-start"
      width={280}
      withArrow
      shadow="md"
      trapFocus
    >
      <Popover.Target>
        <Button
          size="compact-xs"
          variant="light"
          color={color}
          title={label}
          loading={loading}
          disabled={disabled}
          onClick={(e) => {
            e.stopPropagation();
            setOpened((o) => !o);
          }}
        >
          {icon}
        </Button>
      </Popover.Target>
      <Popover.Dropdown onClick={(e) => e.stopPropagation()}>
        <Stack gap="xs">
          <Text size="xs" fw={600}>
            {label}
          </Text>
          <Textarea
            value={note}
            onChange={(e) => setNote(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run();
            }}
            placeholder="optional note for this run…"
            autosize
            minRows={2}
            maxRows={6}
            size="xs"
            // biome-ignore lint/a11y/noAutofocus: deliberate — popover opens for this input.
            autoFocus
          />
          <Button size="xs" color={color} onClick={run}>
            {label}
          </Button>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

/** The shared action cluster for a backlog task (or a whole multi-selection): launch
 *  local 💻▶ / remote ☁️▶ (each with an optional run note), or close it (DONE / WONTDO).
 *  Works on one or many ids — the solo card passes `[task.id]`, the batch bar passes the
 *  selection. `onDone` lets the batch bar clear the selection after an action. */
function TaskActions({ ids, onDone }: { ids: number[]; onDone?: () => void }) {
  const { startLocalMany, dispatchMany, completeTask, cancelTask } = useStore();
  const [running, setRunning] = useState<SessionKind | null>(null);
  const busy = running !== null;

  const launch = async (kind: SessionKind, comment: string) => {
    if (busy || ids.length === 0) return;
    setRunning(kind);
    try {
      if (kind === SessionKind.Local) await startLocalMany(ids, comment);
      else await dispatchMany(ids, comment);
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
      <LaunchButton
        icon="💻 ▶"
        label="Start local"
        loading={running === SessionKind.Local}
        disabled={busy}
        onRun={(c) => launch(SessionKind.Local, c)}
      />
      <LaunchButton
        icon="☁️ ▶"
        label="Dispatch remote"
        color="cyan"
        loading={running === SessionKind.Remote}
        disabled={busy}
        onRun={(c) => launch(SessionKind.Remote, c)}
      />
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
    <Card
      withBorder
      radius="md"
      padding="sm"
      data-pm-card={task.id}
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
  const [listRef] = useAutoAnimate(ANIM_OPTS);
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
        <div ref={listRef} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {tasks.map((t) => (
            <BacklogCard
              key={t.id}
              task={t}
              phases={idx.phasesByTask.get(t.id) ?? []}
              selection={selection}
            />
          ))}
        </div>
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
    <Box
      px="sm"
      py={8}
      data-pm-card={task.id}
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
  const [listRef] = useAutoAnimate(ANIM_OPTS);
  return (
    <div ref={listRef}>
      {starFirst(tasks).map((t) => {
        const m = idx.milestoneById.get(t.milestoneId);
        const g = m ? idx.goalById.get(m.goalId) : undefined;
        const context = [g?.title, m?.title].filter(Boolean).join(" › ");
        return <BacklogRow key={t.id} task={t} idx={idx} context={context} selection={selection} />;
      })}
    </div>
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

/** A card's top within the scroll content — summed offsets up to the scroller. This is
 *  scroll-invariant AND transform-invariant (offsetTop ignores the transforms
 *  auto-animate applies while a re-sort is in flight), so it reads a card's true resting
 *  place even mid-animation. The scroller is `position: relative` so the walk ends there. */
function contentTop(node: HTMLElement, scroller: HTMLElement): number {
  let y = 0;
  let el: HTMLElement | null = node;
  while (el && el !== scroller && scroller.contains(el)) {
    y += el.offsetTop;
    el = el.offsetParent as HTMLElement | null;
  }
  return y;
}

/** The topmost card still on screen (across every group) and how far below the top edge
 *  it sits — the thing the operator is looking at, expressed scroll-invariantly so we
 *  can put it back. Cards carry `data-pm-card` (their task id) as the handle. */
function topAnchor(scroller: HTMLElement): { key: string; offset: number } | null {
  const top = scroller.scrollTop;
  let best: HTMLElement | null = null;
  let bestTop = Number.POSITIVE_INFINITY;
  for (const node of scroller.querySelectorAll<HTMLElement>("[data-pm-card]")) {
    const ct = contentTop(node, scroller);
    if (ct + node.offsetHeight <= top + 1) continue; // scrolled above the top edge
    if (ct < bestTop) {
      bestTop = ct;
      best = node;
    }
  }
  return best ? { key: best.dataset.pmCard ?? "", offset: contentTop(best, scroller) - top } : null;
}

/** Keep your place across a star-driven re-sort. With the browser's scroll anchoring off
 *  (see the scroll Box), a re-sort leaves scrollTop alone but still shifts the content —
 *  the card you were reading slides as the starred card floats above it. So we hold it:
 *  track the topmost on-screen card as you scroll, and after a re-sort put it back at the
 *  same offset by nudging scrollTop. The re-sort then slides the other cards around your
 *  anchor instead of moving you. It's scroll math, not animation, so it holds with motion
 *  off too. We track on `scroll` (not just on render) because scrolling fires no React
 *  render — the anchor must be current at the instant a star lands. */
function usePreserveScrollAcrossResort(scrollRef: React.RefObject<HTMLDivElement | null>) {
  const anchor = useRef<{ key: string; offset: number } | null>(null);

  // Keep the anchor fresh as the operator scrolls.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const track = () => {
      anchor.current = topAnchor(scroller);
    };
    track();
    scroller.addEventListener("scroll", track, { passive: true });
    return () => scroller.removeEventListener("scroll", track);
  }, [scrollRef]);

  // After every render — including a re-sort — restore the anchor card to its remembered
  // offset, then refresh the anchor from the settled position. When nothing moved this is
  // a no-op (it resolves to the current scrollTop); when a star re-sorted, it undoes the
  // shift.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const a = anchor.current;
    if (a) {
      const sel = `[data-pm-card="${a.key.replace(/["\\]/g, "\\$&")}"]`;
      const node = scroller.querySelector<HTMLElement>(sel);
      if (node) {
        const want = contentTop(node, scroller) - a.offset;
        if (Math.abs(scroller.scrollTop - want) > 0.5) scroller.scrollTop = want;
      }
    }
    anchor.current = topAnchor(scroller);
  });
}

export function BacklogPane({ api }: { api?: DockviewPanelApi }) {
  const { idx, activeIds, loading } = usePlanData();
  const [view, setView] = useState<View>("grouped");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const scroll = usePaneScroll("backlog", api);
  usePreserveScrollAcrossResort(scroll.ref);

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
        // overflowAnchor none: when starring re-sorts the list, the browser's own scroll
        // anchoring chases the card that floated to the top and yanks the whole list up
        // to it (scrollTop → 0), losing your place. Turn it off so a re-sort leaves the
        // scroll where it is; usePreserveScrollAcrossResort then holds your exact spot.
        // position relative anchors contentTop's offset walk (see the helper).
        style={{ flex: 1, overflowY: "auto", overflowAnchor: "none", position: "relative" }}
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
