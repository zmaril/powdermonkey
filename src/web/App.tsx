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
import { useEffect, useMemo, useRef, useState } from "react";
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
  const { startLocal, dispatch, land, openSessionTerminal, openEditor } = useStore();
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
              <Badge variant="dot" color="teal" title={session.kind}>
                <span aria-label={session.kind}>{session.kind === "local" ? "💻" : "☁️"}</span>{" "}
                {session.branch}
              </Badge>
              <Button
                size="compact-xs"
                variant={session.needsInput ? "filled" : "light"}
                color="grape"
                onClick={() =>
                  openSessionTerminal(
                    session.id,
                    `${session.kind} · ${session.branch}`.toUpperCase(),
                  )
                }
              >
                Shell
              </Button>
              <Button
                size="compact-xs"
                variant="light"
                color="blue"
                onClick={() => openEditor(session.id)}
                title={
                  session.kind === "local" ? "Open worktree in VS Code" : "Open PR in github.dev"
                }
              >
                VS Code
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
    openNotes,
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
          <Button size="xs" variant="default" onClick={openNotes}>
            Scratch
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

// The scratchpad: one note, one big textarea. Holds its own draft state seeded
// once from the server so the 4s background poll can't clobber what you're typing;
// edits update the draft immediately and debounce a PATCH. The supervisor reads it
// on "check @notes" (GET /notes).
function ScratchPad() {
  const { ensureScratch, saveNote } = useStore();
  const [id, setId] = useState<number | null>(null);
  const [body, setBody] = useState("");
  const [saved, setSaved] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let active = true;
    ensureScratch().then((note) => {
      if (!active || !note) return;
      setId(note.id);
      setBody(note.body);
    });
    return () => {
      active = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [ensureScratch]);

  const onChange = (next: string) => {
    setBody(next);
    if (id == null) return;
    setSaved(false);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      saveNote(id, { body: next }).then(() => setSaved(true));
    }, 500);
  };

  return (
    <div
      style={{ height: "100%", display: "flex", flexDirection: "column", background: "#1a1b1e" }}
    >
      <Group justify="space-between" px="sm" py={6} style={{ flex: "0 0 auto" }}>
        <Text size="xs" c="dimmed" fw={700} style={{ letterSpacing: 0.5 }}>
          SCRATCH
        </Text>
        <Text size="xs" c="dimmed">
          {id == null ? "…" : saved ? "saved" : "saving…"}
        </Text>
      </Group>
      <textarea
        value={body}
        onChange={(e) => onChange(e.currentTarget.value)}
        placeholder="Stray thoughts…"
        spellCheck={false}
        style={{
          flex: 1,
          width: "100%",
          resize: "none",
          border: "none",
          outline: "none",
          background: "#1a1b1e",
          color: "#c1c2c5",
          padding: "4px 12px 12px",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: 13,
          lineHeight: 1.5,
        }}
      />
    </div>
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

function ScratchPanel() {
  return <ScratchPad />;
}

const dockComponents = { shell: ShellPanel, plan: PlanPanel, scratch: ScratchPanel };

export function App() {
  const apiRef = useRef<DockviewApi | null>(null);
  const shellReq = useStore((s) => s.shellReq);
  const notesReq = useStore((s) => s.notesReq);

  const onReady = (event: DockviewReadyEvent) => {
    apiRef.current = event.api;
    // Layout: Plan on the right (main); the left column is split horizontally with
    // the scratchpad on top and the supervisor shell below it.
    event.api.addPanel({ id: "plan", component: "plan", title: "Plan" });
    event.api.addPanel({
      id: "scratch",
      component: "scratch",
      title: "Scratch",
      position: { direction: "left", referencePanel: "plan" },
    });
    event.api.addPanel({
      id: "shell-0",
      component: "shell",
      params: { cwd: "", session: null },
      title: "supervisor",
      position: { direction: "below", referencePanel: "scratch" },
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
      // Session panels show the bare tag (LOCAL · PM/TASK-35); plain shells keep
      // a "shell · " prefix to set them apart.
      title: shellReq.session != null ? shellReq.title : `shell · ${shellReq.title}`,
      position: { referencePanel: "shell-0", direction: "within" },
    });
  }, [shellReq]);

  // Scratch button → focus the scratchpad (recreate it top-left if it was closed).
  useEffect(() => {
    const api = apiRef.current;
    if (!notesReq || !api) return;
    const existing = api.getPanel("scratch");
    if (existing) {
      existing.api.setActive();
      return;
    }
    api.addPanel({
      id: "scratch",
      component: "scratch",
      title: "Scratch",
      position: { referencePanel: "plan", direction: "left" },
    });
  }, [notesReq]);

  return (
    <div style={{ height: "100vh", width: "100vw" }}>
      <DockviewReact components={dockComponents} onReady={onReady} theme={themeAbyss} />
    </div>
  );
}
