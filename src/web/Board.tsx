// The attention board: five columns over the live board. Healthy running
// work is deliberately quiet; the columns that need the operator pop with color.

import {
  Badge,
  Box,
  Button,
  Card,
  Divider,
  Drawer,
  Group,
  Modal,
  ScrollArea,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
  Tooltip,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { useEffect, useMemo, useState } from "react";
import type { ActionRecord } from "../server/repo.ts";
import type { BoardColumn, Task, TaskStatus } from "../shared/types.ts";
import { api } from "./client.ts";
import { Logo } from "./Logo.tsx";
import { useBoard } from "./store.ts";
import {
  emptyWorkspaceFields,
  parseWorkspaceExtras,
  WorkspaceFields,
  type WorkspaceFieldsValue,
} from "./WorkspaceFields.tsx";

interface TaskDiff {
  ok: boolean;
  error?: string;
  stat?: string;
  diff?: string;
  truncated?: boolean;
}

const HIDE_FIELDS = new Set(["updatedAt", "createdAt", "token", "id"]);
function short(v: unknown): string {
  if (v == null) return "∅";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.length > 40 ? s.slice(0, 40) + "…" : s;
}
function ActionItem({ a, showEntity }: { a: ActionRecord; showEntity?: boolean }) {
  const changes = Object.entries(a.diff ?? {}).filter(([k]) => !HIDE_FIELDS.has(k));
  return (
    <Box>
      <Group gap={6} wrap="nowrap">
        <Badge size="xs" variant="light" color="gray">
          {a.actor}
        </Badge>
        <Text size="xs" fw={600}>
          {a.action}
        </Text>
        {showEntity && (
          <Text size="xs" c="dimmed">
            {a.entityType}
          </Text>
        )}
        <Text size="xs" c="dimmed" ml="auto">
          {new Date(a.at).toLocaleTimeString()}
        </Text>
      </Group>
      {a.summary && (
        <Text size="xs" c="dimmed" lineClamp={1}>
          {a.summary}
        </Text>
      )}
      {changes.map(([k, v]) => (
        <Text key={k} size="xs" style={{ fontFamily: "monospace" }} c="dimmed">
          {k}: <span style={{ color: "var(--mantine-color-red-5)" }}>{short(v.from)}</span> →{" "}
          <span style={{ color: "var(--mantine-color-teal-5)" }}>{short(v.to)}</span>
        </Text>
      ))}
    </Box>
  );
}

// Per-task history: the task's full history (fetched once) merged live with any
// new actions pushed over the WS feed.
function TaskHistory({ taskId }: { taskId: string }) {
  const allActions = useBoard((s) => s.actions);
  const live = useMemo(() => allActions.filter((a) => a.entityId === taskId), [allActions, taskId]);
  const [base, setBase] = useState<ActionRecord[] | null>(null);
  useEffect(() => {
    let ok = true;
    api.api
      .tasks({ id: taskId })
      .actions.get()
      .then(({ data }) => {
        if (ok) setBase((data as unknown as ActionRecord[]) ?? []);
      });
    return () => {
      ok = false;
    };
  }, [taskId]);
  const merged = useMemo(() => {
    const byId = new Map<string, ActionRecord>();
    for (const a of [...live, ...(base ?? [])]) byId.set(a.id, a);
    return [...byId.values()].sort((x, y) => y.seq - x.seq);
  }, [live, base]);
  if (!base)
    return (
      <Text size="xs" c="dimmed">
        loading history…
      </Text>
    );
  if (!merged.length)
    return (
      <Text size="xs" c="dimmed">
        no history yet
      </Text>
    );
  return (
    <Stack gap="xs">
      {merged.map((a) => (
        <ActionItem key={a.id} a={a} />
      ))}
    </Stack>
  );
}

// Global activity feed — live from the store (fed by the WS feed, no fetch).
function ActivityDrawer({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const actions = useBoard((s) => s.actions);
  return (
    <Drawer opened={opened} onClose={onClose} position="right" size="md" title="Activity">
      {actions.length === 0 ? (
        <Text size="sm" c="dimmed">
          no activity yet
        </Text>
      ) : (
        <Stack gap="sm">
          {actions.map((a) => (
            <ActionItem key={a.id} a={a} showEntity />
          ))}
        </Stack>
      )}
    </Drawer>
  );
}

// Render a unified diff with +/- line coloring.
function DiffView({ taskId }: { taskId: string }) {
  const [diff, setDiff] = useState<TaskDiff | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let live = true;
    setLoading(true);
    api.api
      .tasks({ id: taskId })
      .diff.get()
      .then(({ data }) => {
        if (live) {
          setDiff((data as TaskDiff) ?? { ok: false, error: "no diff" });
          setLoading(false);
        }
      });
    return () => {
      live = false;
    };
  }, [taskId]);

  if (loading)
    return (
      <Text size="xs" c="dimmed">
        loading diff…
      </Text>
    );
  if (!diff?.ok)
    return (
      <Text size="xs" c="dimmed">
        {diff?.error ?? "no diff"}
      </Text>
    );
  if (!diff.diff?.trim())
    return (
      <Text size="xs" c="dimmed">
        no changes on this branch yet
      </Text>
    );

  const color = (line: string): string | undefined => {
    if (line.startsWith("+++") || line.startsWith("---")) return "dimmed";
    if (line.startsWith("@@")) return "cyan";
    if (line.startsWith("diff --git") || line.startsWith("index ")) return "dimmed";
    if (line.startsWith("+")) return "teal";
    if (line.startsWith("-")) return "red";
    return undefined;
  };

  return (
    <Box>
      {diff.stat && (
        <Text size="xs" c="dimmed" style={{ fontFamily: "monospace", whiteSpace: "pre" }} mb={6}>
          {diff.stat.trim()}
        </Text>
      )}
      <Box
        style={{
          maxHeight: 360,
          overflow: "auto",
          background: "var(--mantine-color-dark-8)",
          borderRadius: 6,
          padding: "8px 10px",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: 11.5,
          lineHeight: 1.5,
        }}
      >
        {diff.diff.split("\n").map((line, i) => (
          <Text key={i} component="div" c={color(line)} style={{ whiteSpace: "pre" }}>
            {line || " "}
          </Text>
        ))}
        {diff.truncated && (
          <Text c="orange" size="xs" mt={4}>
            … diff truncated …
          </Text>
        )}
      </Box>
    </Box>
  );
}

const COLUMNS: { key: BoardColumn; label: string; color: string; hint: string }[] = [
  { key: "working", label: "Working", color: "blue", hint: "the worker's ball — should be boring" },
  {
    key: "needs_input",
    label: "Needs Input",
    color: "orange",
    hint: "your ball — answer or review",
  },
  { key: "done", label: "Done", color: "teal", hint: "operator-marked" },
];

const STATUS_COLOR: Record<TaskStatus, string> = {
  planned: "gray",
  launched: "blue",
  working: "blue",
  waiting_for_me: "orange",
  needs_review: "violet",
  github_action: "red",
  done: "teal",
  abandoned: "dark",
  blocked: "orange",
  failed: "red",
};

function TaskCard({ task, onClick }: { task: Task; onClick: () => void }) {
  return (
    <Card withBorder radius="md" padding="sm" onClick={onClick} style={{ cursor: "pointer" }}>
      <Group justify="space-between" wrap="nowrap" gap="xs">
        <Text fw={600} size="sm" lineClamp={1}>
          {task.title}
        </Text>
        <Badge size="xs" color={STATUS_COLOR[task.status] ?? "gray"} variant="light">
          {task.status}
        </Badge>
      </Group>
      <Text size="xs" c="dimmed" lineClamp={2} mt={4}>
        {task.objective || "—"}
      </Text>
      {task.question && (
        <Text size="xs" c="orange" mt={6} lineClamp={2}>
          ❓ {task.question}
        </Text>
      )}
      {task.lastProgress && !task.question && (
        <Text size="xs" c="dimmed" mt={6} lineClamp={1}>
          ↳ {task.lastProgress}
        </Text>
      )}
      <Group gap={6} mt={8}>
        {task.branch && (
          <Badge size="xs" variant="outline" color="gray">
            {task.branch}
          </Badge>
        )}
        {task.artifacts.length > 0 && (
          <Badge size="xs" variant="dot" color="violet">
            {task.artifacts.length} artifact{task.artifacts.length > 1 ? "s" : ""}
          </Badge>
        )}
      </Group>
    </Card>
  );
}

function TaskDetail() {
  const { board, selectedTaskId, select, answer, approve, comment, markDone, abandon, launch } =
    useBoard();
  const task = board?.tasks.find((t) => t.id === selectedTaskId) ?? null;
  const [answerText, setAnswerText] = useState("");
  const [commentText, setCommentText] = useState("");
  useEffect(() => {
    setAnswerText("");
    setCommentText("");
  }, [selectedTaskId]);
  if (!task) return null;

  const notLaunched = !task.sessionId && task.status === "planned";

  return (
    <Modal opened={!!task} onClose={() => select(null)} title={task.title} size="lg" centered>
      <Stack gap="sm">
        <Group gap="xs">
          <Badge color={STATUS_COLOR[task.status] ?? "gray"}>{task.status}</Badge>
          <Badge variant="outline" color="gray">
            {task.kind}
          </Badge>
          {task.branch && (
            <Badge variant="outline" color="gray">
              {task.branch}
            </Badge>
          )}
        </Group>

        <Box>
          <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
            Objective
          </Text>
          <Text size="sm">{task.objective || "—"}</Text>
        </Box>

        {task.worktreePath && (
          <Text size="xs" c="dimmed">
            worktree: <code>{task.worktreePath}</code>
          </Text>
        )}

        {task.lastProgress && (
          <Box>
            <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
              Last progress
            </Text>
            <Text size="sm">{task.lastProgress}</Text>
          </Box>
        )}

        {task.artifacts.length > 0 && (
          <Box>
            <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
              Artifacts
            </Text>
            <Stack gap={4} mt={4}>
              {task.artifacts.map((a) => (
                <Group key={a.id} gap="xs">
                  <Badge size="xs" color="violet" variant="light">
                    {a.kind}
                  </Badge>
                  <Text size="xs">{a.summary ?? (a.payload?.ref as string) ?? a.id}</Text>
                </Group>
              ))}
            </Stack>
          </Box>
        )}

        {task.branch && (
          <Box>
            <Text size="xs" c="dimmed" tt="uppercase" fw={700} mb={4}>
              Diff · {task.branch}
            </Text>
            <DiffView taskId={task.id} />
          </Box>
        )}

        <Box>
          <Text size="xs" c="dimmed" tt="uppercase" fw={700} mb={4}>
            History
          </Text>
          <TaskHistory taskId={task.id} />
        </Box>

        {task.question && (
          <Box>
            <Text size="xs" c="orange" tt="uppercase" fw={700}>
              Question for you
            </Text>
            <Text size="sm">{task.question}</Text>
            <Group mt="xs" align="flex-end">
              <TextInput
                style={{ flex: 1 }}
                placeholder="your answer…"
                value={answerText}
                onChange={(e) => setAnswerText(e.currentTarget.value)}
              />
              <Button
                disabled={!answerText.trim()}
                onClick={() => {
                  void answer(task.id, answerText.trim());
                  select(null);
                }}
              >
                Answer
              </Button>
            </Group>
          </Box>
        )}

        <Box>
          <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
            Comment
          </Text>
          <Group mt={4} align="flex-end">
            <Textarea
              style={{ flex: 1 }}
              autosize
              minRows={1}
              placeholder="leave a comment (hands back to the worker)…"
              value={commentText}
              onChange={(e) => setCommentText(e.currentTarget.value)}
            />
            <Button
              variant="light"
              disabled={!commentText.trim()}
              onClick={() => {
                void comment(task.id, commentText.trim());
                setCommentText("");
              }}
            >
              Comment
            </Button>
          </Group>
        </Box>

        <Group justify="space-between" mt="sm">
          <Group gap="xs">
            {notLaunched && (
              <Button color="blue" onClick={() => void launch(task.id)}>
                Launch
              </Button>
            )}
            {task.status === "needs_review" && (
              <Button color="violet" variant="light" onClick={() => void approve(task.id)}>
                Approve
              </Button>
            )}
          </Group>
          <Group gap="xs">
            {task.status !== "abandoned" && task.status !== "done" && (
              <Button
                color="gray"
                variant="subtle"
                onClick={() => {
                  void abandon(task.id);
                  select(null);
                }}
              >
                Abandon
              </Button>
            )}
            <Button
              color="teal"
              onClick={() => {
                void markDone(task.id);
                select(null);
              }}
            >
              Mark done
            </Button>
          </Group>
        </Group>
      </Stack>
    </Modal>
  );
}

function NewTaskModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const { board, createTask } = useBoard();
  const workspaces = board?.workspaces ?? [];
  const [workspaceId, setWorkspaceId] = useState<string>("__new__");
  const [pf, setPf] = useState<WorkspaceFieldsValue>(emptyWorkspaceFields);
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [launchNow, setLaunchNow] = useState(true);

  const isNew = workspaceId === "__new__";
  const canSubmit =
    title.trim() && objective.trim() && (isNew ? pf.repoPath.trim() && pf.name.trim() : true);

  const submit = async () => {
    const pid = isNew ? `prj-${Math.random().toString(36).slice(2, 8)}` : workspaceId;
    await createTask({
      workspaceId: pid,
      projectName: isNew ? pf.name.trim() : undefined,
      repoPath: isNew ? pf.repoPath.trim() : undefined,
      ...(isNew ? parseWorkspaceExtras(pf) : {}),
      title: title.trim(),
      objective: objective.trim(),
      launchNow,
    });
    setTitle("");
    setObjective("");
    setPf(emptyWorkspaceFields);
    onClose();
  };

  return (
    <Modal opened={opened} onClose={onClose} title="New task" centered>
      <Stack gap="sm">
        <Select
          label="Workspace"
          data={[
            { value: "__new__", label: "+ New workspace" },
            ...workspaces.map((p) => ({ value: p.id, label: p.name })),
          ]}
          value={workspaceId}
          onChange={(v) => setWorkspaceId(v ?? "__new__")}
        />
        {isNew && <WorkspaceFields value={pf} onChange={setPf} />}
        <TextInput label="Title" value={title} onChange={(e) => setTitle(e.currentTarget.value)} />
        <Textarea
          label="Objective"
          autosize
          minRows={2}
          value={objective}
          onChange={(e) => setObjective(e.currentTarget.value)}
        />
        <Group justify="space-between" mt="xs">
          <Button
            variant={launchNow ? "filled" : "default"}
            onClick={() => setLaunchNow((v) => !v)}
          >
            {launchNow ? "Will launch now ✓" : "Create only"}
          </Button>
          <Button disabled={!canSubmit} onClick={() => void submit()}>
            Create task
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function ProposePlanModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const { board, proposePlan } = useBoard();
  const workspaces = board?.workspaces ?? [];
  const [workspaceId, setWorkspaceId] = useState("__new__");
  const [pf, setPf] = useState<WorkspaceFieldsValue>(emptyWorkspaceFields);
  const [goalTitle, setGoalTitle] = useState("");
  const [intent, setIntent] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const isNew = workspaceId === "__new__";
  const canSubmit = goalTitle.trim() && (isNew ? pf.repoPath.trim() && pf.name.trim() : true);

  const submit = async () => {
    setSubmitting(true);
    const pid = isNew ? `prj-${Math.random().toString(36).slice(2, 8)}` : workspaceId;
    await proposePlan({
      workspaceId: pid,
      projectName: isNew ? pf.name.trim() : undefined,
      repoPath: isNew ? pf.repoPath.trim() : undefined,
      ...(isNew ? parseWorkspaceExtras(pf) : {}),
      goalTitle: goalTitle.trim(),
      intent: intent.trim() || undefined,
    });
    setSubmitting(false);
    setGoalTitle("");
    setIntent("");
    setPf(emptyWorkspaceFields);
    onClose();
  };

  return (
    <Modal opened={opened} onClose={onClose} title="Propose a plan for a goal" centered>
      <Stack gap="sm">
        <Select
          label="Workspace"
          data={[
            { value: "__new__", label: "+ New workspace" },
            ...workspaces.map((p) => ({ value: p.id, label: p.name })),
          ]}
          value={workspaceId}
          onChange={(v) => setWorkspaceId(v ?? "__new__")}
        />
        {isNew && <WorkspaceFields value={pf} onChange={setPf} />}
        <TextInput
          label="Goal"
          placeholder="e.g. Prepare the editor for public launch"
          value={goalTitle}
          onChange={(e) => setGoalTitle(e.currentTarget.value)}
        />
        <Textarea
          label="Intent (optional)"
          autosize
          minRows={2}
          value={intent}
          onChange={(e) => setIntent(e.currentTarget.value)}
        />
        <Text size="xs" c="dimmed">
          The supervisor will read the repo and propose a plan. It appears under Plans for your
          review.
        </Text>
        <Group justify="flex-end">
          <Button loading={submitting} disabled={!canSubmit} onClick={() => void submit()}>
            Propose plan
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function PlansDrawer({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const { board, approvePlan, rejectPlan } = useBoard();
  const proposed = (board?.plans ?? []).filter((p) => p.status === "proposed");
  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position="right"
      size="lg"
      title="Plans awaiting review"
    >
      <Stack gap="md">
        {proposed.length === 0 && (
          <Text size="sm" c="dimmed">
            No plans awaiting review. Use “Propose plan” to have the supervisor draft one.
          </Text>
        )}
        {proposed.map((plan) => (
          <Card key={plan.id} withBorder radius="md" padding="md">
            <Group justify="space-between">
              <Text fw={700}>{plan.title}</Text>
              <Badge color="yellow" variant="light">
                proposed
              </Badge>
            </Group>
            {plan.summary && (
              <Text size="sm" c="dimmed" mt={4}>
                {plan.summary}
              </Text>
            )}
            <Divider my="sm" label={`${plan.proposedTasks.length} tasks`} labelPosition="left" />
            <Stack gap="xs">
              {plan.proposedTasks.map((t, i) => (
                <Box key={i}>
                  <Group gap="xs">
                    <Badge size="xs" variant="outline" color="gray">
                      {t.kind}
                    </Badge>
                    <Text size="sm" fw={600}>
                      {t.title}
                    </Text>
                  </Group>
                  <Text size="xs" c="dimmed">
                    {t.objective}
                  </Text>
                </Box>
              ))}
            </Stack>
            <Group justify="flex-end" mt="md" gap="xs">
              <Button variant="subtle" color="gray" onClick={() => void rejectPlan(plan.id)}>
                Reject
              </Button>
              <Button variant="light" onClick={() => void approvePlan(plan.id, false)}>
                Approve
              </Button>
              <Button color="orange" onClick={() => void approvePlan(plan.id, true)}>
                Approve &amp; launch
              </Button>
            </Group>
          </Card>
        ))}
      </Stack>
    </Drawer>
  );
}

export function Board() {
  const { board, connected, connect, load, select } = useBoard();
  const [newOpen, newHandlers] = useDisclosure(false);
  const [proposeOpen, proposeHandlers] = useDisclosure(false);
  const [plansOpen, plansHandlers] = useDisclosure(false);
  const [activityOpen, activityHandlers] = useDisclosure(false);
  const proposedCount = (board?.plans ?? []).filter((p) => p.status === "proposed").length;

  useEffect(() => {
    void load();
    connect();
  }, []);

  const byColumn = useMemo(() => {
    const m: Record<BoardColumn, Task[]> = {
      working: [],
      needs_input: [],
      done: [],
    };
    for (const t of board?.tasks ?? []) m[t.column].push(t);
    for (const k of Object.keys(m) as BoardColumn[])
      m[k].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    return m;
  }, [board]);

  return (
    <Box p="md" style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <Group justify="space-between" mb="md">
        <Group gap="sm" align="center">
          <Group gap={8} align="center">
            <Logo size={30} />
            <Title order={2} style={{ letterSpacing: -0.5 }}>
              PowderMonkey
            </Title>
          </Group>
          <Tooltip label={connected ? "live" : "reconnecting…"}>
            <Badge color={connected ? "teal" : "red"} variant="dot">
              {connected ? "live" : "offline"}
            </Badge>
          </Tooltip>
          <Text size="xs" c="dimmed">
            {board?.tasks.length ?? 0} tasks · seq {board?.seq ?? 0}
          </Text>
        </Group>
        <Group gap="xs">
          <Button variant="subtle" color="gray" onClick={activityHandlers.open}>
            Activity
          </Button>
          <Button
            variant={proposedCount > 0 ? "light" : "subtle"}
            color={proposedCount > 0 ? "yellow" : "gray"}
            onClick={plansHandlers.open}
          >
            Plans{proposedCount > 0 ? ` (${proposedCount})` : ""}
          </Button>
          <Button variant="light" onClick={proposeHandlers.open}>
            Propose plan
          </Button>
          <Button onClick={newHandlers.open}>+ New task</Button>
        </Group>
      </Group>

      <Group align="stretch" gap="md" wrap="nowrap" style={{ flex: 1, overflow: "hidden" }}>
        {COLUMNS.map((col) => (
          <Stack key={col.key} gap="xs" style={{ flex: 1, minWidth: 220, height: "100%" }}>
            <Group justify="space-between" gap={4}>
              <Group gap={6}>
                <Text fw={700} size="sm">
                  {col.label}
                </Text>
                <Badge size="xs" variant="light" color={col.color}>
                  {byColumn[col.key].length}
                </Badge>
              </Group>
            </Group>
            <Text size="xs" c="dimmed" mt={-6}>
              {col.hint}
            </Text>
            <ScrollArea style={{ flex: 1 }} scrollbarSize={6}>
              <Stack gap="xs" pr={6}>
                {byColumn[col.key].map((t) => (
                  <TaskCard key={t.id} task={t} onClick={() => select(t.id)} />
                ))}
                {byColumn[col.key].length === 0 && (
                  <Text size="xs" c="dimmed" ta="center" mt="lg">
                    —
                  </Text>
                )}
              </Stack>
            </ScrollArea>
          </Stack>
        ))}
      </Group>

      <TaskDetail />
      <NewTaskModal opened={newOpen} onClose={newHandlers.close} />
      <ProposePlanModal opened={proposeOpen} onClose={proposeHandlers.close} />
      <PlansDrawer opened={plansOpen} onClose={plansHandlers.close} />
      <ActivityDrawer opened={activityOpen} onClose={activityHandlers.close} />
    </Box>
  );
}
