import {
  Box,
  Button,
  Card,
  Code,
  CopyButton,
  Group,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useState } from "react";
import type { Goal, Phase, Task } from "../server/schema.ts";
import { partitionTasks } from "./active.ts";
import { api } from "./client.ts";
import { type Indexes, usePlanData } from "./plan-data.ts";
import { LaunchActions, PhaseList, TaskBadges, TaskLinks } from "./plan-ui.tsx";
import { useStore } from "./store.ts";

// The Backlog pane is the launchpad — everything to-be-worked (not active),
// grouped goal → milestone as cards. Each card carries its launch actions
// (Start local / Dispatch remote); a per-milestone "new task" row is the exec-now
// affordance: it creates the task and (optionally) launches a session in one go,
// so the item lands straight in Active.

/** One backlog task card: title + status, its phase checklist, launch actions. */
function BacklogCard({ task, phases }: { task: Task; phases: Phase[] }) {
  return (
    <Card withBorder radius="md" padding="sm">
      <Group justify="space-between" wrap="nowrap" mb={6}>
        <Text fw={500}>{task.title}</Text>
        <TaskBadges task={task} />
      </Group>
      <PhaseList phases={phases} />
      <Group gap="xs" mt={10} justify="space-between">
        <LaunchActions taskId={task.id} />
        <TaskLinks task={task} />
      </Group>
    </Card>
  );
}

/** Exec-now on create: type a title, then either drop it in the backlog or launch
 *  a session immediately (which moves it to Active). New items default to backlog. */
function NewTaskRow({ milestoneId }: { milestoneId: number }) {
  const { refresh, startLocal, setError } = useStore();
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);

  const create = async (launch: boolean) => {
    const name = title.trim();
    if (!name || busy) return;
    setBusy(true);
    const { data, error } = await api.tasks.post({ milestoneId, title: name });
    if (error || !data) {
      setError(error ? String(error.value ?? error.status) : "create failed");
      setBusy(false);
      return;
    }
    setTitle("");
    const id = (data as unknown as Task).id;
    if (launch) await startLocal(id);
    else await refresh();
    setBusy(false);
  };

  return (
    <Group gap="xs" wrap="nowrap">
      <TextInput
        size="xs"
        placeholder="New task…"
        value={title}
        onChange={(e) => setTitle(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") create(false);
        }}
        style={{ flex: 1 }}
      />
      <Button size="compact-xs" variant="light" disabled={busy} onClick={() => create(true)}>
        Start local
      </Button>
      <Button
        size="compact-xs"
        variant="subtle"
        color="gray"
        disabled={busy}
        onClick={() => create(false)}
      >
        Backlog
      </Button>
    </Group>
  );
}

/** A goal and its milestones, each milestone listing its backlog cards + an add row. */
function GoalGroup({ goal, idx, backlog }: { goal: Goal; idx: Indexes; backlog: Set<number> }) {
  const milestones = idx.milestonesByGoal.get(goal.id) ?? [];

  return (
    <Stack gap="md">
      <div>
        <Title order={3}>{goal.title}</Title>
        {goal.objective && (
          <Text c="dimmed" size="sm" mt={4}>
            {goal.objective}
          </Text>
        )}
      </div>

      {milestones.map((m) => {
        const tasks = (idx.tasksByMilestone.get(m.id) ?? []).filter((t) => backlog.has(t.id));
        return (
          <Stack key={m.id} gap="xs">
            <Title order={5}>{m.title}</Title>
            <Stack gap="xs">
              {tasks.map((t) => (
                <BacklogCard key={t.id} task={t} phases={idx.phasesByTask.get(t.id) ?? []} />
              ))}
            </Stack>
            <NewTaskRow milestoneId={m.id} />
          </Stack>
        );
      })}
    </Stack>
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

export function BacklogPane() {
  const { idx, activeIds, loading } = usePlanData();

  // Backlog = everything to-be-worked: not active (no live session) and not merged.
  const allTasks = [...idx.tasksByMilestone.values()].flat();
  const { backlog: backlogList } = partitionTasks(allTasks, activeIds);
  const backlog = new Set(backlogList.filter((t) => t.status !== "merged").map((t) => t.id));
  const goals = [...idx.goals].sort((a, b) => a.id - b.id);

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
      </Group>

      <Box style={{ flex: 1, overflowY: "auto" }} px="md" py={4}>
        <StartPanel />
        {goals.length === 0 ? (
          <Text c="dimmed" size="sm" py="lg">
            No plan loaded. POST one to /plan.
          </Text>
        ) : (
          <Stack gap="xl">
            {goals.map((g) => (
              <GoalGroup key={g.id} goal={g} idx={idx} backlog={backlog} />
            ))}
          </Stack>
        )}
      </Box>
    </Box>
  );
}
