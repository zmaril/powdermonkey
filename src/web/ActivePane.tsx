import {
  Badge,
  Box,
  Card,
  Group,
  SegmentedControl,
  Stack,
  Switch,
  Text,
  Title,
  Tooltip,
} from "@mantine/core";
import { useState } from "react";
import type { CloudPr } from "../server/events.ts";
import type { Goal, Milestone, Session, Task } from "../server/schema.ts";
import { SessionKind } from "../shared/types.ts";
import { partitionTasks } from "./active.ts";
import { type Indexes, starFirst, usePlanData } from "./plan-data.ts";
import {
  IdTag,
  KIND_ICON,
  PrRow,
  SessionActions,
  SessionStateBadge,
  StarToggle,
} from "./plan-ui.tsx";
import { useStore } from "./store.ts";

// now (the derived-active set; see active.ts). The unit here is the WORKER, not
// the task: each live session renders as one card, because a single worker can be
// dispatched for several tasks at once (the session_tasks join). The card header
// carries everything session-level — kind, state (once), session link, Teleport,
// Stop — and the task(s) nest below showing only what's per-task (star, id, title,
// their own PR/CI status). Two views, toggled:
//   • Flat   — worker cards in one list.
//   • Grouped — the same cards nested under goal → milestone.
// It re-renders off the same WebSocket change feed as the rest of the app, so
// session state (running / Try Again / needs you) stays current without a refresh.

type View = "flat" | "grouped";

type SessionGrouping = { session: Session; tasks: Task[] };

/** Group active tasks by the live session they share, preserving input order (so a
 *  star-first list stays star-first). Every active task has a session — the active
 *  set is derived from sessions — but a task whose session somehow doesn't resolve
 *  is skipped rather than rendered sessionless. */
function groupBySession(tasks: Task[], idx: Indexes): SessionGrouping[] {
  const groups = new Map<number, SessionGrouping>();
  const order: number[] = [];
  for (const t of tasks) {
    const session = idx.sessionByTask.get(t.id);
    if (!session) continue;
    let g = groups.get(session.id);
    if (!g) {
      g = { session, tasks: [] };
      groups.set(session.id, g);
      order.push(session.id);
    }
    g.tasks.push(t);
  }
  return order.map((id) => groups.get(id) as SessionGrouping);
}

/** The goal › milestone trail a task hangs under. */
function contextOf(task: Task, idx: Indexes): string {
  const m = idx.milestoneById.get(task.milestoneId);
  const g = m ? idx.goalById.get(m.goalId) : undefined;
  return [g?.title, m?.title].filter(Boolean).join(" › ");
}

/** One task line inside a worker card's Tasks column: star · id · title · (context).
 *  Nothing session-level (kind/state/controls live in the header) and no PR — PRs
 *  get their own column on the right. */
function TaskLine({ task, context }: { task: Task; context?: string }) {
  return (
    <Group gap="sm" wrap="nowrap" align="flex-start">
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
    </Group>
  );
}

/** A tiny uppercase column label (Tasks / PRs) for the worker card body. */
function ColumnLabel({ children }: { children: string }) {
  return (
    <Text size="xs" c="dimmed" fw={700} tt="uppercase" style={{ letterSpacing: 0.5 }}>
      {children}
    </Text>
  );
}

/** The PRs a worker's tasks have opened, de-duped by PR number (a multi-task worker
 *  can land one PR for several tasks). */
function workerPrs(tasks: Task[], idx: Indexes): CloudPr[] {
  const out: CloudPr[] = [];
  const seen = new Set<number>();
  for (const t of tasks) {
    const pr = idx.prByTask.get(t.id);
    if (pr && !seen.has(pr.number)) {
      seen.add(pr.number);
      out.push(pr);
    }
  }
  return out;
}

/** One worker = one card. The header holds everything session-level (kind · state ·
 *  shared context · session link · Teleport · Stop); the task(s) the worker is
 *  running nest below. Single- and multi-task workers render the same way, so the
 *  pane is visually consistent. `showContext` puts the shared goal › milestone trail
 *  in the header (flat view); under grouped headings it's redundant, so it's off —
 *  and if a worker spans milestones, each task line carries its own context. */
function WorkerCard({
  session,
  tasks,
  idx,
  showContext,
}: {
  session: Session;
  tasks: Task[];
  idx: Indexes;
  showContext: boolean;
}) {
  const contexts = showContext ? [...new Set(tasks.map((t) => contextOf(t, idx)))] : [];
  const sharedContext = contexts.length === 1 ? contexts[0] : undefined;
  const perTaskContext = contexts.length > 1;
  const prs = workerPrs(tasks, idx);
  return (
    <Card withBorder radius="md" padding="sm" bg="#1f2023">
      {/* Top: session status + controls, full width. */}
      <Group justify="space-between" wrap="nowrap" align="flex-start" mb={10}>
        <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
          <Text size="sm" title={session.kind}>
            {KIND_ICON[session.kind]}
          </Text>
          <SessionStateBadge session={session} />
          {sharedContext && (
            <Text size="xs" c="dimmed" truncate>
              {sharedContext}
            </Text>
          )}
        </Group>
        <SessionActions session={session} taskId={tasks[0].id} />
      </Group>

      {/* Bottom: tasks, then their PRs below — single column so titles are readable. */}
      <Stack gap={10}>
        <Stack gap={6}>
          <ColumnLabel>Tasks</ColumnLabel>
          {tasks.map((t) => (
            <TaskLine
              key={t.id}
              task={t}
              context={perTaskContext ? contextOf(t, idx) : undefined}
            />
          ))}
        </Stack>
        <Stack gap={6}>
          <ColumnLabel>PRs</ColumnLabel>
          {prs.length === 0 ? (
            <Text size="xs" c="dimmed">
              none yet
            </Text>
          ) : (
            prs.map((pr) => <PrRow key={pr.number} pr={pr} />)
          )}
        </Stack>
      </Stack>
    </Card>
  );
}

function FlatView({ tasks, idx }: { tasks: Task[]; idx: Indexes }) {
  const groups = groupBySession(starFirst(tasks), idx);
  return (
    <Stack gap="xs">
      {groups.map((g) => (
        <WorkerCard key={g.session.id} session={g.session} tasks={g.tasks} idx={idx} showContext />
      ))}
    </Stack>
  );
}

function GroupedView({ activeIds, idx }: { activeIds: Set<number>; idx: Indexes }) {
  const goals = [...idx.goals].sort((a, b) => a.id - b.id);
  const sections: { goal: Goal; milestone: Milestone; groups: SessionGrouping[] }[] = [];
  for (const goal of goals) {
    for (const m of idx.milestonesByGoal.get(goal.id) ?? []) {
      const tasks = starFirst(
        (idx.tasksByMilestone.get(m.id) ?? []).filter((t) => activeIds.has(t.id)),
      );
      if (tasks.length > 0)
        sections.push({ goal, milestone: m, groups: groupBySession(tasks, idx) });
    }
  }
  return (
    <Stack gap="lg">
      {sections.map(({ goal, milestone, groups }) => (
        <Box key={milestone.id}>
          <Group gap={6} wrap="nowrap" align="baseline">
            <IdTag prefix="g" id={goal.id} />
            <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
              {goal.title}
            </Text>
          </Group>
          <Group gap={8} wrap="nowrap" align="baseline" mb={6}>
            <IdTag prefix="m" id={milestone.id} />
            <Title order={5}>{milestone.title}</Title>
          </Group>
          <Stack gap="xs">
            {groups.map((g) => (
              <WorkerCard
                key={g.session.id}
                session={g.session}
                tasks={g.tasks}
                idx={idx}
                showContext={false}
              />
            ))}
          </Stack>
        </Box>
      ))}
    </Stack>
  );
}

export function ActivePane() {
  const { idx, activeIds } = usePlanData();
  const autoRebase = useStore((s) => s.autoRebase);
  const setAutoRebase = useStore((s) => s.setAutoRebase);
  const [view, setView] = useState<View>("flat");

  const allTasks = [...idx.tasksByMilestone.values()].flat();
  const { active } = partitionTasks(allTasks, activeIds);
  // The ACTIVE count is the number of WORKERS (distinct live sessions), not tasks —
  // one worker can carry several tasks, so counting tasks overstates what's running.
  // Broken out per environment: how many cloud workers vs local worktrees.
  const activeSessions = new Map<number, Session>();
  for (const t of active) {
    const s = idx.sessionByTask.get(t.id);
    if (s) activeSessions.set(s.id, s);
  }
  const cloudCount = [...activeSessions.values()].filter(
    (s) => s.kind === SessionKind.Remote,
  ).length;
  const localCount = [...activeSessions.values()].filter(
    (s) => s.kind === SessionKind.Local,
  ).length;

  return (
    <Box
      style={{ height: "100%", display: "flex", flexDirection: "column", background: "#1a1b1e" }}
    >
      <Group justify="space-between" px="md" py={8} style={{ flex: "0 0 auto" }}>
        <Group gap={8}>
          <Text size="xs" c="dimmed" fw={700} style={{ letterSpacing: 0.5 }}>
            ACTIVE
          </Text>
          <Badge
            size="sm"
            variant="light"
            color={cloudCount > 0 ? "blue" : "gray"}
            title="cloud sessions"
          >
            {KIND_ICON[SessionKind.Remote]} {cloudCount}
          </Badge>
          <Badge
            size="sm"
            variant="light"
            color={localCount > 0 ? "blue" : "gray"}
            title="local sessions"
          >
            {KIND_ICON[SessionKind.Local]} {localCount}
          </Badge>
        </Group>
        <Group gap="md" wrap="nowrap">
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
              styles={{ label: { fontSize: "var(--mantine-font-size-xs)", color: "#909296" } }}
            />
          </Tooltip>
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
      </Group>

      <Box style={{ flex: 1, overflowY: "auto" }} px="md" py="xs">
        {active.length === 0 ? (
          <Text c="dimmed" size="sm" py="lg">
            Nothing active. Launch a task from the Backlog (Start local / Dispatch remote, or "/" →
            Start local on a new line) and it shows up here.
          </Text>
        ) : view === "flat" ? (
          <FlatView tasks={active} idx={idx} />
        ) : (
          <GroupedView activeIds={activeIds} idx={idx} />
        )}
      </Box>
    </Box>
  );
}
