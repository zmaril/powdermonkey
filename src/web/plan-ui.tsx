import {
  Anchor,
  Badge,
  Button,
  Group,
  List,
  Progress,
  Text,
  ThemeIcon,
  UnstyledButton,
} from "@mantine/core";
import type { CloudPr } from "../server/events.ts";
import type { Phase, Session, Task } from "../server/schema.ts";
import {
  CheckRollupState,
  MergeableState,
  PhaseStatus,
  SessionKind,
  SessionState,
  TaskStatus,
} from "../shared/types.ts";
import { rollup } from "./progress.ts";
import { useStore } from "./store.ts";

// Shared rendering for both panes (Active and Backlog): the status/session badges,
// the rolled-up progress bar, the phase checklist, and the per-task action buttons.
// Keeping these in one place means a task looks the same whichever pane shows it.

export const STATUS_COLOR: Record<TaskStatus, string> = {
  [TaskStatus.Pending]: "gray",
  [TaskStatus.Dispatched]: "blue",
  [TaskStatus.Merged]: "green",
};

// "Try Again" is the user-facing label for a session parked waiting to resume.
export const SESSION_BADGE: Record<SessionState, { label: string; color: string }> = {
  [SessionState.Running]: { label: "running", color: "blue" },
  [SessionState.Waiting]: { label: "Try Again", color: "yellow" },
  [SessionState.Idle]: { label: "idle", color: "gray" },
  [SessionState.Stopped]: { label: "stopped", color: "red" },
};

// Glyph per session kind. Typed as Record<SessionKind, …> so adding a kind is a
// compile error here until it has an icon — the same total-coverage guarantee the
// status/badge maps rely on.
export const KIND_ICON: Record<SessionKind, string> = {
  [SessionKind.Local]: "💻",
  [SessionKind.Remote]: "☁️",
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

/** A click-to-toggle priority star. Starred tasks sort to the top of their group
 *  (active / backlog). `flexShrink: 0` so it never collapses in a tight row. */
export function StarToggle({ task }: { task: Task }) {
  const toggleStar = useStore((s) => s.toggleStar);
  return (
    <UnstyledButton
      aria-label={task.starred ? "Unstar task" : "Star task"}
      title={task.starred ? "Unstar" : "Star — sorts to the top of its group"}
      onClick={(e) => {
        e.stopPropagation();
        toggleStar(task.id, !task.starred);
      }}
      style={{ flexShrink: 0, lineHeight: 1 }}
    >
      <Text span c={task.starred ? "yellow" : "dimmed"} style={{ userSelect: "none" }}>
        {task.starred ? "★" : "☆"}
      </Text>
    </UnstyledButton>
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
            <ThemeIcon
              color={p.status === PhaseStatus.Done ? "green" : "gray"}
              size={16}
              radius="xl"
            >
              <Text size="9px">{p.status === PhaseStatus.Done ? "✓" : "·"}</Text>
            </ThemeIcon>
          }
        >
          <Text
            size="sm"
            c={p.status === PhaseStatus.Done ? "dimmed" : undefined}
            td={p.status === PhaseStatus.Done ? "line-through" : undefined}
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

/** The session/status badge cluster shown next to a task title. `showStatus` is off
 *  in the Active pane — every active task is "dispatched" by definition, so the
 *  status badge there is just noise next to the live session state. */
export function TaskBadges({
  task,
  session,
  showStatus = true,
}: { task: Task; session?: Session; showStatus?: boolean }) {
  // The live session row is the real signal ("is it running"); local/teleported
  // sessions never set the denormalized task.sessionState, so prefer session.state
  // and only fall back to the task field when there's no live session attached.
  const state = session?.state ?? task.sessionState;
  return (
    <Group gap={6} wrap="nowrap">
      {session?.needsInput && (
        <Badge color="yellow" variant="filled">
          needs you
        </Badge>
      )}
      {state && (
        <Badge color={SESSION_BADGE[state].color} variant="filled">
          {SESSION_BADGE[state].label}
        </Badge>
      )}
      {showStatus && (
        <Badge color={STATUS_COLOR[task.status]} variant="light">
          {task.status}
        </Badge>
      )}
    </Group>
  );
}

/** Actions for a task that currently HAS a live session. A local session runs in a
 *  worktree, so it gets Shell + VS Code; a remote (cloud) session has neither — it
 *  lives on claude.ai, so it gets a link out to the session plus Teleport to pull
 *  it down. Both get Land / Stop. `taskId` is the row's task — a session can cover
 *  several, so teleport pulls down the one the operator clicked from (its whole
 *  batch follows). */
export function SessionActions({ session, taskId }: { session: Session; taskId: number }) {
  const { land, stop, teleport, openSessionTerminal, openEditor, pending } = useStore();
  const isRemote = session.kind === SessionKind.Remote;
  const teleporting = pending[`teleport:${taskId}`] ?? false;
  return (
    <Group gap="xs" wrap="nowrap">
      <Badge variant="dot" color="teal" title={session.kind}>
        <span aria-label={session.kind}>{KIND_ICON[session.kind]}</span>{" "}
        {session.branch ?? "remote"}
      </Badge>
      {isRemote ? (
        <>
          {session.url && (
            <Anchor href={session.url} target="_blank" size="sm" fw={500}>
              session ↗
            </Anchor>
          )}
          <Button
            size="compact-xs"
            variant="light"
            color="grape"
            title="Pull this cloud session down to a local worktree (claude --teleport)"
            loading={teleporting}
            disabled={teleporting}
            onClick={() => teleport(taskId)}
          >
            Teleport
          </Button>
        </>
      ) : (
        <>
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
            title="Open worktree in VS Code"
          >
            VS Code
          </Button>
        </>
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
  const { startLocal, dispatch, pending } = useStore();
  const startingLocal = pending[`start-local:${taskId}`] ?? false;
  const dispatching = pending[`dispatch:${taskId}`] ?? false;
  // Disable both while either is in flight so a task can't be launched twice; the one
  // that was clicked carries the spinner so it's clear which action is working.
  const busy = startingLocal || dispatching;
  return (
    <Group gap="xs" wrap="nowrap">
      <Button
        size="compact-xs"
        variant="light"
        loading={startingLocal}
        disabled={busy}
        onClick={() => startLocal(taskId)}
      >
        Start local
      </Button>
      <Button
        size="compact-xs"
        variant="subtle"
        color="gray"
        loading={dispatching}
        disabled={busy}
        onClick={() => dispatch(taskId)}
      >
        Dispatch remote
      </Button>
    </Group>
  );
}

// GitHub's statusCheckRollup states → a compact CI chip.
const CHECK_BADGE: Record<CheckRollupState, { label: string; color: string }> = {
  [CheckRollupState.Success]: { label: "CI ✓", color: "green" },
  [CheckRollupState.Failure]: { label: "CI ✗", color: "red" },
  [CheckRollupState.Error]: { label: "CI ✗", color: "red" },
  [CheckRollupState.Pending]: { label: "CI …", color: "yellow" },
  [CheckRollupState.Expected]: { label: "CI …", color: "yellow" },
};

/** Live PR status chips for a task with a tracked PR — draft, merge conflicts, CI.
 *  Fed from github-watch (idx.prByTask), so it trails GitHub by at most the poll
 *  interval (~10s). Renders nothing when there's nothing noteworthy to show. */
export function PrStatus({ pr }: { pr: CloudPr }) {
  const ci = pr.checks ? CHECK_BADGE[pr.checks] : undefined;
  const conflicting = pr.mergeable === MergeableState.Conflicting;
  if (!pr.isDraft && !conflicting && !ci) return null;
  return (
    <Group gap={4} wrap="nowrap">
      {pr.isDraft && (
        <Badge size="xs" variant="light" color="gray">
          draft
        </Badge>
      )}
      {conflicting && (
        <Badge size="xs" variant="filled" color="red" title="Has merge conflicts with main">
          conflicts
        </Badge>
      )}
      {ci && (
        <Badge size="xs" variant="light" color={ci.color} title={`CI: ${pr.checks}`}>
          {ci.label}
        </Badge>
      )}
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
