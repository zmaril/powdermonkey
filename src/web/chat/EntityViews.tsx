// Main-pane views for a selected workspace / goal / task. Read the live board
// store; the task view reuses the worker diff + action endpoints.

import { useThreadListNew } from "@assistant-ui/core/react";
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Center,
  Code,
  Group,
  Paper,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useEffect, useMemo, useState } from "react";
import type { MilestoneStatus, TaskStatus } from "../../shared/types.ts";
import { api } from "../client.ts";
import { useBoard } from "../store.ts";
import { useBind } from "./bind.ts";
import { ScratchpadView } from "./Scratchpad.tsx";
import { useView, View } from "./view.ts";
import { WorkerChat } from "./WorkerChat.tsx";
import { WorkspacesView } from "./WorkspacesView.tsx";

const STATUS_COLOR: Record<TaskStatus, string> = {
  waiting_for_me: "yellow",
  needs_review: "violet",
  blocked: "red",
  working: "blue",
  launched: "blue",
  planned: "gray",
  done: "teal",
  abandoned: "dark",
  failed: "red",
  github_action: "red",
};

function Shell({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Box style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
      <Box maw={780} mx="auto" w="100%" px="xl" py="xl">
        <Text size="xs" c="dimmed" tt="uppercase" mb={4}>
          {eyebrow}
        </Text>
        <Title order={2} mb="lg" style={{ fontFamily: "Georgia, serif" }}>
          {title}
        </Title>
        {children}
      </Box>
    </Box>
  );
}

function WorkspaceView({ id }: { id: string }) {
  const board = useBoard((s) => s.board);
  const setView = useView((s) => s.setView);
  const workspace = board?.workspaces.find((p) => p.id === id);
  const goals = board?.goals.filter((g) => g.workspaceId === id) ?? [];
  const { switchToNewThread } = useThreadListNew();
  const setPending = useBind((s) => s.setPending);
  if (!workspace)
    return (
      <Shell eyebrow="Workspace" title="Not found">
        {null}
      </Shell>
    );
  return (
    <Shell eyebrow="Workspace" title={workspace.name}>
      <Stack gap="md">
        <Group>
          <Button
            size="xs"
            variant="light"
            color="orange"
            onClick={() => {
              setPending({ kind: "supervisor", workspaceId: id });
              switchToNewThread();
            }}
          >
            Chat with supervisor
          </Button>
          <Button
            size="xs"
            variant="subtle"
            color="gray"
            onClick={async () => {
              await archiveEntity("workspaces", id);
              setView(View.None());
            }}
          >
            Archive workspace
          </Button>
        </Group>
        {workspace.repoPath && (
          <Text size="sm" c="dimmed">
            <Code>{workspace.repoPath}</Code>
          </Text>
        )}
        <Text size="sm" fw={600}>
          Goals
        </Text>
        {goals.length === 0 ? (
          <Text size="sm" c="dimmed">
            No goals yet.
          </Text>
        ) : (
          goals.map((g) => (
            <Paper
              key={g.id}
              withBorder
              p="sm"
              radius="md"
              bg="dark.6"
              style={{ cursor: "pointer" }}
              onClick={() => setView(View.Goal({ id: g.id }))}
            >
              <Text size="sm" fw={500}>
                {g.title}
              </Text>
              {g.intent && (
                <Text size="xs" c="dimmed">
                  {g.intent}
                </Text>
              )}
            </Paper>
          ))
        )}
      </Stack>
    </Shell>
  );
}

const MS_COLOR: Record<MilestoneStatus, string> = {
  pending: "gray",
  active: "blue",
  awaiting_approval: "yellow",
  done: "teal",
  abandoned: "dark",
};
const JSON_HEADERS = { "content-type": "application/json" };

// Archive (never delete) a top-level entity, then the WS feed drops it from the board.
async function archiveEntity(kind: "workspaces" | "goals" | "tasks", id: string) {
  await fetch(`/api/${kind}/${id}/archive`, { method: "POST" });
}

function MilestoneList({ goalId }: { goalId: string }) {
  const board = useBoard((s) => s.board);
  const setView = useView((s) => s.setView);
  const [title, setTitle] = useState("");
  const reload = () => void useBoard.getState().load();

  const ms = useMemo(
    () =>
      (board?.milestones ?? [])
        .filter((m) => m.goalId === goalId)
        .sort((a, b) => a.orderHint - b.orderHint),
    [board, goalId],
  );
  const tasksByMs = useMemo(() => {
    const m = new Map<string, NonNullable<typeof board>["tasks"]>();
    for (const t of board?.tasks ?? []) {
      if (t.milestoneId) {
        const l = m.get(t.milestoneId) ?? [];
        l.push(t);
        m.set(t.milestoneId, l);
      }
    }
    return m;
  }, [board]);
  const hasActive = ms.some((m) => m.status === "active");

  const add = async () => {
    const t = title.trim();
    if (!t) return;
    await fetch(`/api/goals/${goalId}/milestones`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: t }),
    });
    setTitle("");
    reload();
  };
  const patch = async (mid: string, body: object) => {
    await fetch(`/api/milestones/${mid}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
    reload();
  };
  const approve = async (mid: string) => {
    await fetch(`/api/milestones/${mid}/approve`, { method: "POST" });
    reload();
  };
  const del = async (mid: string) => {
    await fetch(`/api/milestones/${mid}/archive`, { method: "POST" });
    reload();
  };
  const move = async (i: number, dir: number) => {
    const j = i + dir;
    if (j < 0 || j >= ms.length) return;
    const a = ms[i];
    const b = ms[j];
    await Promise.all([
      fetch(`/api/milestones/${a.id}`, {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: JSON.stringify({ orderHint: b.orderHint }),
      }),
      fetch(`/api/milestones/${b.id}`, {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: JSON.stringify({ orderHint: a.orderHint }),
      }),
    ]);
    reload();
  };

  return (
    <Stack gap="sm">
      <Text size="sm" fw={600}>
        Milestones
      </Text>
      {ms.length === 0 && (
        <Text size="xs" c="dimmed">
          No milestones yet — break this goal into an ordered sequence.
        </Text>
      )}
      {ms.map((m, i) => (
        <Paper
          key={m.id}
          withBorder
          p="sm"
          radius="md"
          bg="dark.6"
          style={m.status === "active" ? { borderColor: "var(--mantine-color-blue-7)" } : undefined}
        >
          <Group justify="space-between" wrap="nowrap" align="flex-start">
            <Box style={{ flex: 1 }}>
              <Group gap="xs">
                <Badge size="xs" variant="light" color={MS_COLOR[m.status] ?? "gray"}>
                  {m.status.replace(/_/g, " ")}
                </Badge>
                <Text size="sm" fw={500}>
                  {i + 1}. {m.title}
                </Text>
              </Group>
              {m.detail && (
                <Text size="xs" c="dimmed" mt={2}>
                  {m.detail}
                </Text>
              )}
              {(tasksByMs.get(m.id) ?? []).map((t) => (
                <Text
                  key={t.id}
                  size="xs"
                  c="gray.4"
                  mt={4}
                  style={{ cursor: "pointer" }}
                  onClick={() => setView(View.Task({ id: t.id }))}
                >
                  · {t.title}{" "}
                  <Text span c="dimmed">
                    [{t.status}]
                  </Text>
                </Text>
              ))}
            </Box>
            <Group gap={4} wrap="nowrap">
              {m.status === "pending" && !hasActive && (
                <Button
                  size="compact-xs"
                  variant="light"
                  color="blue"
                  onClick={() => patch(m.id, { status: "active" })}
                >
                  Start
                </Button>
              )}
              {(m.status === "active" || m.status === "awaiting_approval") && (
                <Button size="compact-xs" color="teal" onClick={() => approve(m.id)}>
                  Approve →
                </Button>
              )}
              {m.status === "pending" && (
                <>
                  <ActionIcon
                    size="sm"
                    variant="subtle"
                    color="gray"
                    onClick={() => move(i, -1)}
                    aria-label="move up"
                  >
                    ↑
                  </ActionIcon>
                  <ActionIcon
                    size="sm"
                    variant="subtle"
                    color="gray"
                    onClick={() => move(i, 1)}
                    aria-label="move down"
                  >
                    ↓
                  </ActionIcon>
                </>
              )}
              <ActionIcon
                size="sm"
                variant="subtle"
                color="red"
                onClick={() => del(m.id)}
                aria-label="archive"
              >
                ×
              </ActionIcon>
            </Group>
          </Group>
        </Paper>
      ))}
      <Group gap="xs">
        <TextInput
          size="xs"
          placeholder="New milestone…"
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
          style={{ flex: 1 }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void add();
          }}
        />
        <Button size="xs" variant="light" onClick={add} disabled={!title.trim()}>
          Add
        </Button>
      </Group>
    </Stack>
  );
}

function GoalView({ id }: { id: string }) {
  const board = useBoard((s) => s.board);
  const setView = useView((s) => s.setView);
  const approvePlan = useBoard((s) => s.approvePlan);
  const rejectPlan = useBoard((s) => s.rejectPlan);
  const { switchToNewThread } = useThreadListNew();
  const setPending = useBind((s) => s.setPending);
  const goal = board?.goals.find((g) => g.id === id);
  const plans = board?.plans.filter((p) => p.goalId === id) ?? [];
  if (!goal)
    return (
      <Shell eyebrow="Goal" title="Not found">
        {null}
      </Shell>
    );
  return (
    <Shell eyebrow="Goal" title={goal.title}>
      <Stack gap="md">
        <Group>
          <Button
            size="xs"
            variant="light"
            color="orange"
            onClick={() => {
              setPending({ kind: "supervisor", goalId: id });
              switchToNewThread();
            }}
          >
            Chat with supervisor
          </Button>
          <Button
            size="xs"
            variant="subtle"
            color="gray"
            onClick={async () => {
              await archiveEntity("goals", id);
              setView(View.None());
            }}
          >
            Archive goal
          </Button>
        </Group>
        {goal.intent && (
          <Text size="sm" c="dimmed">
            {goal.intent}
          </Text>
        )}
        {plans
          .filter((p) => p.status === "proposed")
          .map((p) => (
            <Paper
              key={p.id}
              withBorder
              p="md"
              radius="md"
              bg="dark.7"
              style={{ borderColor: "var(--mantine-color-orange-9)" }}
            >
              <Badge color="orange" variant="light" size="sm" mb={6}>
                proposed plan
              </Badge>
              <Text fw={600} size="sm">
                {p.title}
              </Text>
              {p.summary && (
                <Text size="xs" c="dimmed" mt={4}>
                  {p.summary}
                </Text>
              )}
              <Group gap="xs" mt="sm">
                <Button size="xs" color="orange" onClick={() => void approvePlan(p.id, true)}>
                  Approve & launch
                </Button>
                <Button size="xs" variant="light" onClick={() => void approvePlan(p.id, false)}>
                  Approve
                </Button>
                <Button
                  size="xs"
                  variant="subtle"
                  color="gray"
                  onClick={() => void rejectPlan(p.id)}
                >
                  Reject
                </Button>
              </Group>
            </Paper>
          ))}
        <MilestoneList goalId={id} />
      </Stack>
    </Shell>
  );
}

function TaskDiff({ id }: { id: string }) {
  const [diff, setDiff] = useState<{
    ok?: boolean;
    diff?: string;
    stat?: string;
    error?: string;
  } | null>(null);
  useEffect(() => {
    let live = true;
    api.api
      .tasks({ id })
      .diff.get()
      .then(({ data }) => {
        if (live) setDiff((data as any) ?? null);
      });
    return () => {
      live = false;
    };
  }, [id]);
  if (!diff)
    return (
      <Text size="xs" c="dimmed">
        loading diff…
      </Text>
    );
  if (diff.error || !diff.diff)
    return (
      <Text size="xs" c="dimmed">
        No diff yet.
      </Text>
    );
  return (
    <Code block style={{ maxHeight: 320, overflow: "auto", fontSize: 12 }}>
      {diff.stat ? `${diff.stat}\n\n` : ""}
      {diff.diff}
    </Code>
  );
}

function TaskView({ id }: { id: string }) {
  const board = useBoard((s) => s.board);
  const approve = useBoard((s) => s.approve);
  const markDone = useBoard((s) => s.markDone);
  const abandon = useBoard((s) => s.abandon);
  const launch = useBoard((s) => s.launch);
  const setView = useView((s) => s.setView);
  const [showDiff, setShowDiff] = useState(false);
  const task = board?.tasks.find((t) => t.id === id);
  if (!task) {
    return (
      <Shell eyebrow="Task" title="Not found">
        {null}
      </Shell>
    );
  }
  return (
    <Box style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <Box px="xl" py="md" style={{ borderBottom: "1px solid var(--mantine-color-dark-4)" }}>
        <Text size="xs" c="dimmed" tt="uppercase">
          Task
        </Text>
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <Box>
            <Title order={3} style={{ fontFamily: "Georgia, serif" }}>
              {task.title}
            </Title>
            <Group gap="xs" mt={4}>
              <Badge color={STATUS_COLOR[task.status] ?? "gray"} variant="light">
                {task.status}
              </Badge>
              {task.branch && <Code>{task.branch}</Code>}
            </Group>
          </Box>
          <Group gap="xs">
            <Button
              size="xs"
              variant="subtle"
              color="gray"
              onClick={async () => {
                await archiveEntity("tasks", id);
                setView(View.None());
              }}
            >
              Archive
            </Button>
            {task.status === "planned" && (
              <Button size="xs" color="blue" onClick={() => void launch(id)}>
                Launch
              </Button>
            )}
            {task.status === "failed" && (
              <Button size="xs" color="orange" onClick={() => void launch(id)}>
                Relaunch
              </Button>
            )}
            {task.status === "needs_review" && (
              <Button size="xs" color="violet" onClick={() => void approve(id)}>
                Approve
              </Button>
            )}
            <Button size="xs" variant="subtle" color="gray" onClick={() => setShowDiff((v) => !v)}>
              Diff
            </Button>
            <Button size="xs" variant="light" onClick={() => void markDone(id)}>
              Done
            </Button>
            <Button size="xs" variant="subtle" color="red" onClick={() => void abandon(id)}>
              Abandon
            </Button>
          </Group>
        </Group>
        {task.objective && (
          <Text size="sm" c="dimmed" mt="xs">
            {task.objective}
          </Text>
        )}
        {showDiff && (
          <Box mt="sm">
            <TaskDiff id={id} />
          </Box>
        )}
      </Box>
      <WorkerChat taskId={id} />
    </Box>
  );
}

// One exhaustive match over every view kind — add a kind to View and this fails
// to compile until you handle it.
export function EntityView({ view }: { view: View }) {
  return View.$match(view, {
    None: () => (
      <Center style={{ flex: 1 }}>
        <Text c="dimmed" size="sm" maw={440} ta="center" px="md">
          Pick a workspace, goal, or task on the left to work on it here. Chat with the supervisor
          on the right.
        </Text>
      </Center>
    ),
    Scratchpad: () => <ScratchpadView />,
    Workspaces: () => <WorkspacesView />,
    Workspace: ({ id }) => <WorkspaceView id={id} />,
    Goal: ({ id }) => <GoalView id={id} />,
    Task: ({ id }) => <TaskView id={id} />,
  });
}
