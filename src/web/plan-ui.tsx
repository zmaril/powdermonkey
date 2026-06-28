import {
  Anchor,
  Badge,
  Box,
  Button,
  Group,
  List,
  Progress,
  Text,
  ThemeIcon,
  UnstyledButton,
} from "@mantine/core";
import { useState } from "react";
import type { AgentStatus, CloudPr } from "../server/events.ts";
import type { Phase, Session, Task } from "../server/schema.ts";
import {
  AgentState,
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

/** The live session's state, shown once in a worker card's header: a "needs you"
 *  flag when it's parked for input, plus the running / Try Again / idle / stopped
 *  badge. The state belongs to the worker, not each task, so it lives here. */
export function SessionStateBadge({ session }: { session: Session }) {
  return (
    <Group gap={6} wrap="nowrap">
      {session.needsInput && (
        <Badge color="yellow" variant="filled">
          needs you
        </Badge>
      )}
      <Badge color={SESSION_BADGE[session.state].color} variant="filled">
        {SESSION_BADGE[session.state].label}
      </Badge>
    </Group>
  );
}

/** Actions for a task that currently HAS a live session. A local session runs in a
 *  worktree, so it gets Shell + VS Code; a remote (cloud) session has neither — it
 *  lives on claude.ai, so it gets a link out to the session plus Teleport to pull
 *  it down. Both get Stop. `taskId` is the row's task — a session can cover
 *  several, so teleport pulls down the one the operator clicked from (its whole
 *  batch follows). */
export function SessionActions({ session, taskId }: { session: Session; taskId: number }) {
  const { stop, teleport, openSessionTerminal, openEditor, pending } = useStore();
  const isRemote = session.kind === SessionKind.Remote;
  const teleporting = pending[`teleport:${taskId}`] ?? false;
  // No kind/branch badge here — the worker card's header already shows the kind
  // icon and running state, so repeating "☁ remote" next to it was pure noise.
  return (
    <Group gap="xs" wrap="nowrap">
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

/** One GitHub-style status dot folding CI + mergeability into a single glance:
 *  conflicts / CI failure → red, CI running → yellow, passing or no-conflicts →
 *  green, merged → violet, nothing-known-yet → gray. */
function prDot(pr: CloudPr): { color: string; title: string } {
  if (pr.merged) return { color: "violet", title: "merged" };
  if (pr.mergeable === MergeableState.Conflicting)
    return { color: "red", title: "merge conflicts" };
  if (pr.checks === CheckRollupState.Failure || pr.checks === CheckRollupState.Error)
    return { color: "red", title: "CI failing" };
  if (pr.checks === CheckRollupState.Pending || pr.checks === CheckRollupState.Expected)
    return { color: "yellow", title: "CI running" };
  if (pr.checks === CheckRollupState.Success) return { color: "green", title: "CI passing" };
  if (pr.mergeable === MergeableState.Mergeable) return { color: "green", title: "no conflicts" };
  return { color: "gray", title: "no status yet" };
}

// The worker's self-reported state → a compact chip colour. Typed Record<AgentState,…>
// so adding a state is a compile error here until it has a colour — the same
// total-coverage guarantee KIND_ICON / SESSION_BADGE rely on. An unrecognised status
// word is parsed to state:null upstream (no chip), so there's no open-string case here.
const AGENT_BADGE: Record<AgentState, { color: string }> = {
  [AgentState.Starting]: { color: "blue" },
  [AgentState.Working]: { color: "blue" },
  [AgentState.Blocked]: { color: "red" },
  [AgentState.Done]: { color: "green" },
};

/** The agent-authored state chip, plus the needs-you flag. `blocked` is the needs-you
 *  signal — a loud filled chip plus an explicit "needs you" badge so a blocked worker
 *  can't be missed. Renders nothing until the worker has posted a known status. */
function AgentStateBadge({ agent }: { agent: AgentStatus }) {
  if (!agent.state) return null;
  const blocked = agent.state === AgentState.Blocked;
  const color = AGENT_BADGE[agent.state].color;
  return (
    <Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
      <Badge
        size="xs"
        variant={blocked ? "filled" : "light"}
        color={color}
        title={agent.summary ?? `agent: ${agent.state}`}
      >
        {agent.state}
      </Badge>
      {blocked && (
        <Badge
          size="xs"
          variant="filled"
          color="orange"
          title={agent.summary ?? "The worker is blocked and needs you."}
        >
          needs you
        </Badge>
      )}
    </Group>
  );
}

/** The agent's own narrative: the one-line summary (and `next`) always, with the full
 *  sticky-comment body one click away — the human-readable glance at what the agent
 *  thinks is happening, not just the parsed fields. Renders nothing until the worker
 *  has posted something. */
function AgentNarrative({ agent }: { agent: AgentStatus }) {
  const [open, setOpen] = useState(false);
  if (!agent.summary && !agent.next && !agent.body) return null;
  const hasBody = agent.body.trim().length > 0;
  return (
    <Box pl={16}>
      <Group gap={6} wrap="nowrap" align="baseline">
        <Box style={{ flex: 1, minWidth: 0 }}>
          {agent.summary && (
            <Text size="xs" c="dimmed" title={agent.summary} truncate={!open}>
              {agent.summary}
            </Text>
          )}
          {agent.next && (
            <Text size="xs" c="dimmed" title={agent.next} truncate={!open}>
              → next: {agent.next}
            </Text>
          )}
        </Box>
        {agent.sessionUrl && (
          <Anchor
            href={agent.sessionUrl}
            target="_blank"
            size="xs"
            fw={500}
            style={{ flex: "0 0 auto" }}
            title="The cloud session that authored this status"
          >
            session ↗
          </Anchor>
        )}
        {hasBody && (
          <UnstyledButton onClick={() => setOpen((o) => !o)} style={{ flex: "0 0 auto" }}>
            <Text size="xs" c="blue.4">
              {open ? "hide" : "details"}
            </Text>
          </UnstyledButton>
        )}
      </Group>
      {open && hasBody && (
        <Box
          mt={4}
          p={8}
          style={{ border: "1px solid #2c2e33", borderRadius: 4, background: "#141517" }}
        >
          <Text
            size="xs"
            c="dimmed"
            style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "monospace" }}
          >
            {agent.body}
          </Text>
        </Box>
      )}
    </Box>
  );
}

/** One PR row in a worker card: a status dot (CI + conflicts, GitHub-style) · the
 *  #number (link) · the title · the worker's agent-state chip. The agent's narrative
 *  (summary / next, with the full sticky comment on expand) sits below the row. */
export function PrRow({ pr }: { pr: CloudPr }) {
  const dot = prDot(pr);
  return (
    <Box>
      <Group gap="xs" wrap="nowrap">
        <Box
          w={8}
          h={8}
          title={dot.title}
          style={{
            borderRadius: "50%",
            background: `var(--mantine-color-${dot.color}-6)`,
            flexShrink: 0,
          }}
        />
        <Anchor
          href={pr.url}
          target="_blank"
          size="sm"
          fw={600}
          ff="monospace"
          style={{ flexShrink: 0 }}
        >
          #{pr.number}
        </Anchor>
        <Text size="sm" truncate style={{ flex: 1, minWidth: 0 }}>
          {pr.title}
        </Text>
        {pr.agent && <AgentStateBadge agent={pr.agent} />}
      </Group>
      {pr.agent && <AgentNarrative agent={pr.agent} />}
    </Box>
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
