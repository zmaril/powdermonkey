import {
  Anchor,
  Badge,
  Button,
  Card,
  Code,
  Container,
  CopyButton,
  Group,
  List,
  Progress,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from "@mantine/core";
import "dockview-core/dist/styles/dockview.css";
import {
  type DockviewApi,
  DockviewReact,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
  themeAbyss,
} from "dockview-react";
import { useEffect, useMemo, useRef } from "react";
import type { Goal, Milestone, Phase, Session, Task } from "../server/schema.ts";
import type { SessionState, TaskStatus } from "../shared/types.ts";
import { ShellTerminal } from "./ShellTerminal.tsx";
import { rollup } from "./progress.ts";
import { useStore } from "./store.ts";

const STATUS_COLOR: Record<TaskStatus, string> = {
  pending: "gray",
  dispatched: "blue",
  merged: "green",
};

// "Try Again" is the user-facing label for a session parked waiting to resume.
const SESSION_BADGE: Record<SessionState, { label: string; color: string }> = {
  running: { label: "running", color: "blue" },
  waiting: { label: "Try Again", color: "yellow" },
  idle: { label: "idle", color: "gray" },
};

const byPosition = <T extends { position: number }>(a: T, b: T) => a.position - b.position;

function ProgressBar({ phases }: { phases: Phase[] }) {
  const { done, total, pct } = rollup(phases);
  return (
    <Group gap="sm" wrap="nowrap" w="100%">
      <Progress value={pct} size="lg" radius="sm" style={{ flex: 1 }} />
      <Text size="sm" c="dimmed" w={60} ta="right">
        {done}/{total}
      </Text>
    </Group>
  );
}

function PhaseList({ phases }: { phases: Phase[] }) {
  return (
    <List spacing={2} size="sm" center>
      {phases.map((p) => (
        <List.Item
          key={p.id}
          icon={
            <ThemeIcon color={p.status === "done" ? "green" : "gray"} size={16} radius="xl">
              <Text size="9px">{p.status === "done" ? "✓" : "·"}</Text>
            </ThemeIcon>
          }
        >
          <Text
            size="sm"
            c={p.status === "done" ? "dimmed" : undefined}
            td={p.status === "done" ? "line-through" : undefined}
          >
            {p.name}{" "}
            <Text span c="dimmed" size="xs">
              #{p.id}
            </Text>
          </Text>
        </List.Item>
      ))}
    </List>
  );
}

function TaskCard({ task, phases, session }: { task: Task; phases: Phase[]; session?: Session }) {
  const { startLocal, dispatch, land, openSessionTerminal } = useStore();
  return (
    <Card withBorder radius="md" padding="sm">
      <Group justify="space-between" wrap="nowrap" mb={6}>
        <Text fw={500}>{task.title}</Text>
        <Group gap={6} wrap="nowrap">
          {session?.needsInput && (
            <Badge color="yellow" variant="filled">
              needs you
            </Badge>
          )}
          {task.sessionState && (
            <Badge color={SESSION_BADGE[task.sessionState].color} variant="filled">
              {SESSION_BADGE[task.sessionState].label}
            </Badge>
          )}
          <Badge color={STATUS_COLOR[task.status]} variant="light">
            {task.status}
          </Badge>
        </Group>
      </Group>

      <PhaseList phases={phases} />

      <Group gap="xs" mt={10} justify="space-between">
        <Group gap="xs">
          {session ? (
            <>
              <Badge variant="dot" color="teal">
                {session.kind} · {session.branch}
              </Badge>
              <Button
                size="compact-xs"
                variant={session.needsInput ? "filled" : "light"}
                color="grape"
                onClick={() => openSessionTerminal(session.id, task.title)}
              >
                Shell
              </Button>
              <Button
                size="compact-xs"
                variant="light"
                color="teal"
                onClick={() => land(session.id)}
              >
                Land
              </Button>
            </>
          ) : (
            <>
              <Button size="compact-xs" variant="light" onClick={() => startLocal(task.id)}>
                Start local
              </Button>
              <Button
                size="compact-xs"
                variant="subtle"
                color="gray"
                onClick={() => dispatch(task.id)}
              >
                Dispatch remote
              </Button>
            </>
          )}
        </Group>
        <Group gap="md">
          {task.sessionUrl && (
            <Anchor href={task.sessionUrl} target="_blank" size="sm">
              session ↗
            </Anchor>
          )}
          {task.prUrl && (
            <Anchor href={task.prUrl} target="_blank" size="sm">
              PR ↗
            </Anchor>
          )}
        </Group>
      </Group>
    </Card>
  );
}

type Indexes = {
  milestonesByGoal: Map<number, Milestone[]>;
  tasksByMilestone: Map<number, Task[]>;
  phasesByTask: Map<number, Phase[]>;
  sessionByTask: Map<number, Session>;
};

function phasesUnder(tasks: Task[], idx: Indexes): Phase[] {
  return tasks.flatMap((t) => idx.phasesByTask.get(t.id) ?? []);
}

function GoalView({ goal, idx }: { goal: Goal; idx: Indexes }) {
  const milestones = idx.milestonesByGoal.get(goal.id) ?? [];
  const allTasks = milestones.flatMap((m) => idx.tasksByMilestone.get(m.id) ?? []);

  return (
    <Stack gap="lg">
      <div>
        <Title order={2}>{goal.title}</Title>
        <Text c="dimmed" size="sm" mt={4}>
          {goal.objective}
        </Text>
        <Stack mt="sm" gap={4}>
          <ProgressBar phases={phasesUnder(allTasks, idx)} />
        </Stack>
      </div>

      {milestones.map((m) => {
        const tasks = idx.tasksByMilestone.get(m.id) ?? [];
        return (
          <Stack key={m.id} gap="xs">
            <Title order={4}>{m.title}</Title>
            <ProgressBar phases={phasesUnder(tasks, idx)} />
            <Stack gap="xs" mt={4}>
              {tasks.map((t) => (
                <TaskCard
                  key={t.id}
                  task={t}
                  phases={idx.phasesByTask.get(t.id) ?? []}
                  session={idx.sessionByTask.get(t.id)}
                />
              ))}
            </Stack>
          </Stack>
        );
      })}
    </Stack>
  );
}

function StartPanel() {
  const { lastStart, dismissStart } = useStore();
  if (!lastStart) return null;
  return (
    <Card withBorder radius="md" mb="lg" bg="dark.6">
      <Group justify="space-between" mb="xs">
        <Text fw={600}>Local session ready · {lastStart.branch}</Text>
        <Button size="compact-xs" variant="subtle" color="gray" onClick={dismissStart}>
          dismiss
        </Button>
      </Group>
      <Text size="sm" c="dimmed">
        Worktree: <Code>{lastStart.worktreePath}</Code>
      </Text>
      <Text size="sm" mt="xs" mb={4}>
        Paste this into a Claude session running in that worktree:
      </Text>
      <Code block style={{ whiteSpace: "pre-wrap" }}>
        {lastStart.prompt}
      </Code>
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

function PlanView() {
  const {
    goals,
    milestones,
    tasks,
    phases,
    sessions,
    loading,
    error,
    refresh,
    reconcile,
    openTerminal,
  } = useStore();

  // Refresh on mount and on a light poll so progress appears as branches land.
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 4000);
    return () => clearInterval(id);
  }, [refresh]);

  const idx = useMemo<Indexes>(() => {
    const milestonesByGoal = new Map<number, Milestone[]>();
    for (const m of [...milestones].sort(byPosition)) {
      const list = milestonesByGoal.get(m.goalId) ?? [];
      list.push(m);
      milestonesByGoal.set(m.goalId, list);
    }
    const tasksByMilestone = new Map<number, Task[]>();
    for (const t of [...tasks].sort(byPosition)) {
      const list = tasksByMilestone.get(t.milestoneId) ?? [];
      list.push(t);
      tasksByMilestone.set(t.milestoneId, list);
    }
    const phasesByTask = new Map<number, Phase[]>();
    for (const p of [...phases].sort(byPosition)) {
      const list = phasesByTask.get(p.taskId) ?? [];
      list.push(p);
      phasesByTask.set(p.taskId, list);
    }
    const sessionByTask = new Map<number, Session>();
    for (const s of sessions) if (s.taskId != null) sessionByTask.set(s.taskId, s);
    return { milestonesByGoal, tasksByMilestone, phasesByTask, sessionByTask };
  }, [milestones, tasks, phases, sessions]);

  return (
    <Container size="md" py="xl" style={{ height: "100%", overflowY: "auto" }}>
      <Group justify="space-between" mb="xl">
        <Title order={1}>PowderMonkey</Title>
        <Group gap="sm">
          {loading && (
            <Text size="sm" c="dimmed">
              loading…
            </Text>
          )}
          <Button size="xs" variant="default" onClick={() => openTerminal("")}>
            Shell
          </Button>
          <Button size="xs" variant="default" onClick={reconcile}>
            Reconcile
          </Button>
        </Group>
      </Group>

      {error && (
        <Text c="red" mb="md">
          {error}
        </Text>
      )}

      <StartPanel />

      {goals.length === 0 && !loading ? (
        <Text c="dimmed">No plan loaded. POST one to /plan.</Text>
      ) : (
        <Stack gap="xl">
          {goals.map((g) => (
            <GoalView key={g.id} goal={g} idx={idx} />
          ))}
        </Stack>
      )}
    </Container>
  );
}

function ShellPanel(props: IDockviewPanelProps<{ cwd: string; session: number | null }>) {
  return (
    <div style={{ height: "100%", width: "100%", background: "#1a1b1e" }}>
      <ShellTerminal
        cwd={props.params.cwd || undefined}
        session={props.params.session ?? undefined}
      />
    </div>
  );
}

function PlanPanel() {
  return <PlanView />;
}

const dockComponents = { shell: ShellPanel, plan: PlanPanel };

export function App() {
  const apiRef = useRef<DockviewApi | null>(null);
  const shellReq = useStore((s) => s.shellReq);

  const onReady = (event: DockviewReadyEvent) => {
    apiRef.current = event.api;
    // Plan on the right (main), shell on the left.
    event.api.addPanel({ id: "plan", component: "plan", title: "Plan" });
    event.api.addPanel({
      id: "shell-0",
      component: "shell",
      params: { cwd: "", session: null },
      title: "shell · repo",
      position: { direction: "left", referencePanel: "plan" },
    });
  };

  // Each open*Terminal() adds (or focuses) a shell panel keyed by shellReq.key.
  useEffect(() => {
    const api = apiRef.current;
    if (!shellReq || !api) return;
    const id = shellReq.key === "repo" ? "shell-0" : `shell-${shellReq.key}`;
    const existing = api.getPanel(id);
    if (existing) {
      existing.api.setActive();
      return;
    }
    api.addPanel({
      id,
      component: "shell",
      params: { cwd: shellReq.cwd, session: shellReq.session },
      title: `shell · ${shellReq.title}`,
      position: { referencePanel: "shell-0", direction: "within" },
    });
  }, [shellReq]);

  return (
    <div style={{ height: "100vh", width: "100vw" }}>
      <DockviewReact components={dockComponents} onReady={onReady} theme={themeAbyss} />
    </div>
  );
}
