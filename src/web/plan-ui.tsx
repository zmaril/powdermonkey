import { Anchor, Badge, Button, Group, List, Progress, Text, ThemeIcon } from "@mantine/core";
import type { Phase, Session, Task } from "../server/schema.ts";
import type { SessionState, TaskStatus } from "../shared/types.ts";
import { rollup } from "./progress.ts";
import { useStore } from "./store.ts";

// Shared rendering for both panes (Active and Backlog): the status/session badges,
// the rolled-up progress bar, the phase checklist, and the per-task action buttons.
// Keeping these in one place means a task looks the same whichever pane shows it.

export const STATUS_COLOR: Record<TaskStatus, string> = {
  pending: "gray",
  dispatched: "blue",
  merged: "green",
};

// "Try Again" is the user-facing label for a session parked waiting to resume.
export const SESSION_BADGE: Record<SessionState, { label: string; color: string }> = {
  running: { label: "running", color: "blue" },
  waiting: { label: "Try Again", color: "yellow" },
  idle: { label: "idle", color: "gray" },
  stopped: { label: "stopped", color: "red" },
};

/** A small monospace id chip (g1 / m6 / t110 / p41) so the operator can reference
 *  any entity by id. `flexShrink: 0` keeps it visible when a title truncates. */
export function IdTag({ prefix, id }: { prefix: string; id: number }) {
  return (
    <Text span c="dimmed" size="xs" ff="monospace" style={{ flexShrink: 0 }}>
      {prefix}
      {id}
    </Text>
  );
}

export function ProgressBar({ phases }: { phases: Phase[] }) {
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

/** Compact done/total pill — for the dense rows where a full bar is too heavy. */
export function ProgressPill({ phases }: { phases: Phase[] }) {
  const { done, total, pct } = rollup(phases);
  return (
    <Group gap={6} wrap="nowrap" w={96}>
      <Progress value={pct} size="sm" radius="sm" style={{ flex: 1 }} />
      <Text size="xs" c="dimmed" w={34} ta="right" ff="monospace">
        {done}/{total}
      </Text>
    </Group>
  );
}

export function PhaseList({ phases }: { phases: Phase[] }) {
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

/** The session/status badge cluster shown next to a task title. */
export function TaskBadges({ task, session }: { task: Task; session?: Session }) {
  return (
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
  );
}

/** Actions for a task that currently HAS a live session: shell, editor, land, stop. */
export function SessionActions({ session }: { session: Session }) {
  const { land, stop, teleport, openSessionTerminal, openEditor } = useStore();
  return (
    <Group gap="xs" wrap="nowrap">
      <Badge variant="dot" color="teal" title={session.kind}>
        <span aria-label={session.kind}>{session.kind === "local" ? "💻" : "☁️"}</span>{" "}
        {session.branch ?? "remote"}
      </Badge>
      <Button
        size="compact-xs"
        variant={session.needsInput ? "filled" : "light"}
        color="grape"
        onClick={() =>
          openSessionTerminal(session.id, `${session.kind} · ${session.branch}`.toUpperCase())
        }
      >
        Shell
      </Button>
      <Button
        size="compact-xs"
        variant="light"
        color="blue"
        onClick={() => openEditor(session.id)}
        title={session.kind === "local" ? "Open worktree in VS Code" : "Open PR in github.dev"}
      >
        VS Code
      </Button>
      {session.kind === "remote" && session.taskId != null && (
        <Button
          size="compact-xs"
          variant="light"
          color="grape"
          title="Pull this cloud session down to a local worktree (claude --teleport)"
          onClick={() => teleport(session.taskId as number)}
        >
          Teleport
        </Button>
      )}
      <Button size="compact-xs" variant="light" color="teal" onClick={() => land(session.id)}>
        Land
      </Button>
      <Button
        size="compact-xs"
        variant="light"
        color="red"
        title="Abort this session — kills the agent and re-pends the task"
        onClick={() => {
          if (
            window.confirm(
              "Stop this session? The agent is killed, its worktree discarded, and the task returns to pending.",
            )
          )
            stop(session.id);
        }}
      >
        Stop
      </Button>
    </Group>
  );
}

/** Launch actions for a backlog task (no live session yet). */
export function LaunchActions({ taskId }: { taskId: number }) {
  const { startLocal, dispatch } = useStore();
  return (
    <Group gap="xs" wrap="nowrap">
      <Button size="compact-xs" variant="light" onClick={() => startLocal(taskId)}>
        Start local
      </Button>
      <Button size="compact-xs" variant="subtle" color="gray" onClick={() => dispatch(taskId)}>
        Dispatch remote
      </Button>
    </Group>
  );
}

export function TaskLinks({ task }: { task: Task }) {
  return (
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
  );
}
