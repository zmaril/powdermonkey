import { Button, Group, Stack, Text, Title } from "@mantine/core";
import { IconExternalLink } from "@tabler/icons-react";
import { useLiveQuery } from "@tanstack/react-db";
import { SessionState } from "../../shared/types.ts";
import { sessionsCollection, sessionTasksCollection, tasksCollection } from "../collections.ts";
import { useStore } from "../store.ts";

// Shown over a shell pane whose attached session has ended (landed / merged /
// stopped, or its agent exited) — see ShellTerminal's onEnded. Instead of a blank,
// dead terminal the operator gets a clear end-state and a way out: close the pane,
// open a fresh shell (at the session's worktree if it still exists, else the repo —
// the server falls back), or jump to the PR. PR / worktree are looked up from the
// store by session id; the session<->task join is returned for archived sessions too,
// so the PR link survives the session being archived on land/merge.
export function SessionEndedOverlay({
  sessionId,
  onClose,
}: {
  sessionId: number;
  onClose: () => void;
}) {
  const openTerminal = useStore((s) => s.openTerminal);
  // The collections stream every row (live + archived), so the session and its PR
  // link survive the session being archived on land/merge.
  const sessions = useLiveQuery(() => sessionsCollection).data ?? [];
  const tasks = useLiveQuery(() => tasksCollection).data ?? [];
  const links = useLiveQuery(() => sessionTasksCollection).data ?? [];
  const session = sessions.find((x) => x.id === sessionId);
  const taskIds = new Set(links.filter((l) => l.sessionId === sessionId).map((l) => l.taskId));
  const prUrl = tasks.find((t) => taskIds.has(t.id) && t.prUrl)?.prUrl ?? null;
  const worktree = session?.worktreePath ?? "";
  const message =
    session?.state === SessionState.Stopped
      ? "This session was stopped — its agent was killed and the task re-pended."
      : "This session has ended — landed, merged, or its agent exited.";
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--pm-overlay-scrim)",
        padding: 16,
      }}
    >
      <Stack gap="sm" align="center" maw={420} style={{ textAlign: "center" }}>
        <Title order={5}>Session ended</Title>
        <Text size="sm" c="dimmed">
          {message}
          {session?.branch ? ` (${session.branch})` : ""}
        </Text>
        <Group gap="xs" justify="center">
          <Button size="compact-sm" variant="default" onClick={onClose}>
            Close pane
          </Button>
          <Button size="compact-sm" variant="light" onClick={() => openTerminal(worktree)}>
            Open a shell
          </Button>
          {prUrl && (
            <Button
              size="compact-sm"
              variant="light"
              color="blue"
              component="a"
              href={prUrl}
              target="_blank"
              rightSection={<IconExternalLink size={14} />}
            >
              View PR
            </Button>
          )}
        </Group>
      </Stack>
    </div>
  );
}
