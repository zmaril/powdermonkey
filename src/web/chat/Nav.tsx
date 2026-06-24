// Sidebar work navigation: the Inbox (items needing attention) and the
// Workspace ▸ Goal ▸ Milestone ▸ task tree. Both read the live board store.

import {
  ActionIcon,
  Box,
  Button,
  Group,
  Modal,
  NavLink,
  ScrollArea,
  Stack,
  Text,
  UnstyledButton,
} from "@mantine/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import type { TaskStatus } from "../../shared/types.ts";
import { useBoard } from "../store.ts";
import {
  emptyWorkspaceFields,
  parseWorkspaceExtras,
  WorkspaceFields,
} from "../WorkspaceFields.tsx";
import { useView, View } from "./view.ts";

const ATTENTION: ReadonlySet<TaskStatus> = new Set([
  "waiting_for_me",
  "needs_review",
  "blocked",
  "failed",
]);
const DONE: ReadonlySet<TaskStatus> = new Set(["done", "abandoned"]);

const STATUS_COLOR: Record<TaskStatus, string> = {
  waiting_for_me: "yellow",
  needs_review: "violet",
  blocked: "red",
  working: "blue",
  launched: "blue",
  planned: "gray",
  failed: "red",
  github_action: "red",
  done: "teal",
  abandoned: "dark",
};

function Dot({ color }: { color: string }) {
  return (
    <Box
      w={7}
      h={7}
      style={{ borderRadius: "50%", background: `var(--mantine-color-${color}-5)`, flexShrink: 0 }}
    />
  );
}

export function Inbox() {
  const board = useBoard((s) => s.board);
  const setView = useView((s) => s.setView);
  const items = useMemo(() => {
    if (!board) return [] as { key: string; label: string; color: string; onClick: () => void }[];
    const milestones = board.milestones
      .filter((m) => m.status === "awaiting_approval")
      .map((m) => ({
        key: `ms-${m.id}`,
        label: `Milestone ready: ${m.title}`,
        color: "yellow",
        onClick: () => setView(View.Goal({ id: m.goalId })),
      }));
    const plans = board.plans
      .filter((p) => p.status === "proposed")
      .map((p) => ({
        key: `plan-${p.id}`,
        label: `Plan: ${p.title}`,
        color: "orange",
        onClick: () => setView(View.Goal({ id: p.goalId })),
      }));
    const tasks = [...board.tasks]
      .filter((t) => ATTENTION.has(t.status))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .map((t) => ({
        key: `task-${t.id}`,
        label: t.title,
        color: STATUS_COLOR[t.status] ?? "gray",
        onClick: () => setView(View.Task({ id: t.id })),
      }));
    return [...milestones, ...plans, ...tasks].slice(0, 5);
  }, [board, setView]);

  return (
    <Box px="xs">
      <Text size="xs" c="dimmed" px="sm" pb={2} tt="uppercase">
        Needs review
      </Text>
      {items.length === 0 ? (
        <Text size="xs" c="dimmed" px="sm" py={4}>
          Nothing needs you right now.
        </Text>
      ) : (
        items.map((it) => (
          <NavLink
            key={it.key}
            label={
              <Text size="sm" truncate>
                {it.label}
              </Text>
            }
            leftSection={<Dot color={it.color} />}
            onClick={it.onClick}
          />
        ))
      )}
    </Box>
  );
}

// Everything going on right now: every non-archived goal across all workspaces,
// each with its active tasks. The workspace is shown as a small tag for context.
export function GoalsTree() {
  const board = useBoard((s) => s.board);
  const setView = useView((s) => s.setView);

  const tasksByGoal = useMemo(() => {
    const tbg = new Map<string, NonNullable<typeof board>["tasks"]>();
    if (board) {
      const wsToGoal = new Map(board.workstreams.map((w) => [w.id, w.goalId]));
      for (const t of board.tasks) {
        if (DONE.has(t.status)) continue;
        const goalId = t.workstreamId ? wsToGoal.get(t.workstreamId) : undefined;
        if (!goalId) continue;
        const list = tbg.get(goalId) ?? [];
        list.push(t);
        tbg.set(goalId, list);
      }
    }
    return tbg;
  }, [board]);

  if (!board) return null;
  const wsName = new Map(board.workspaces.map((w) => [w.id, w.name]));
  const goals = board.goals;

  const taskNode = (t: NonNullable<typeof board>["tasks"][number]) => (
    <NavLink
      key={t.id}
      label={
        <Text size="sm" truncate>
          {t.title}
        </Text>
      }
      leftSection={<Dot color={STATUS_COLOR[t.status] ?? "gray"} />}
      onClick={() => setView(View.Task({ id: t.id }))}
    />
  );

  return (
    <Box px="xs">
      <Text size="xs" c="dimmed" px="sm" pb={2} tt="uppercase">
        Now
      </Text>
      <Stack gap={0}>
        {goals.length === 0 ? (
          <Text size="xs" c="dimmed" px="sm">
            Nothing going on yet.
          </Text>
        ) : (
          goals.map((g) => (
            <NavLink
              key={g.id}
              label={
                <Box>
                  <Text size="sm" truncate>
                    {g.title}
                  </Text>
                  <Text size="10px" c="dimmed" truncate>
                    {wsName.get(g.workspaceId) ?? "—"}
                  </Text>
                </Box>
              }
              childrenOffset={12}
              defaultOpened
              onClick={() => setView(View.Goal({ id: g.id }))}
            >
              {(tasksByGoal.get(g.id) ?? []).map(taskNode)}
            </NavLink>
          ))
        )}
      </Stack>
    </Box>
  );
}

// Operator-created workspace: name + repo dir, with Advanced (subpath/secrets/env/setup).
function NewWorkspace() {
  const reloadBoard = useBoard((s) => s.load);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(emptyWorkspaceFields);
  const create = async () => {
    if (!form.name.trim()) return;
    await fetch("/api/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: form.name.trim(),
        repoPath: form.repoPath.trim() || undefined,
        ...parseWorkspaceExtras(form),
      }),
    });
    setForm(emptyWorkspaceFields);
    setOpen(false);
    await reloadBoard();
  };
  return (
    <>
      <ActionIcon
        variant="subtle"
        color="gray"
        size="sm"
        aria-label="New workspace"
        onClick={() => setOpen(true)}
      >
        ＋
      </ActionIcon>
      <Modal opened={open} onClose={() => setOpen(false)} title="New workspace" centered>
        <Stack>
          <WorkspaceFields value={form} onChange={setForm} />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button color="orange" onClick={create} disabled={!form.name.trim()}>
              Create workspace
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}

interface ArchivedData {
  workspaces: { id: string; name: string }[];
  goals: { id: string; title: string }[];
  tasks: { id: string; title: string }[];
  milestones: { id: string; title: string }[];
}

// Archived (never deleted) items, with one-click restore. Re-fetches whenever the
// board changes (an archive/restore bumps the board seq).
export function Archived() {
  const seq = useBoard((s) => s.board?.seq);
  const reloadBoard = useBoard((s) => s.load);
  const [data, setData] = useState<ArchivedData | null>(null);
  const refetch = useCallback(async () => {
    try {
      const r = await fetch("/api/archived");
      setData((await r.json()) as ArchivedData);
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    void refetch();
  }, [refetch, seq]);

  const rows: {
    kind: "workspaces" | "goals" | "tasks" | "milestones";
    id: string;
    label: string;
  }[] = data
    ? [
        ...data.workspaces.map((p) => ({ kind: "workspaces" as const, id: p.id, label: p.name })),
        ...data.goals.map((g) => ({ kind: "goals" as const, id: g.id, label: g.title })),
        ...data.milestones.map((m) => ({
          kind: "milestones" as const,
          id: m.id,
          label: m.title,
        })),
        ...data.tasks.map((t) => ({ kind: "tasks" as const, id: t.id, label: t.title })),
      ]
    : [];
  if (!rows.length) return null;

  const restore = async (kind: string, id: string) => {
    await fetch(`/api/${kind}/${id}/restore`, { method: "POST" });
    await reloadBoard();
    await refetch();
  };

  return (
    <Box px="sm">
      <Text size="xs" fw={700} c="dimmed" tt="uppercase" mb={4}>
        Archived
      </Text>
      <Stack gap={2}>
        {rows.map((r) => (
          <Group key={`${r.kind}-${r.id}`} gap="xs" wrap="nowrap" justify="space-between">
            <Text size="xs" c="dimmed" truncate style={{ flex: 1 }}>
              {r.label}
            </Text>
            <Button
              size="compact-xs"
              variant="subtle"
              color="gray"
              onClick={() => restore(r.kind, r.id)}
            >
              Restore
            </Button>
          </Group>
        ))}
      </Stack>
    </Box>
  );
}
