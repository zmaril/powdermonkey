import { Anchor, Button, Group } from "@mantine/core";
import { IconExternalLink } from "@tabler/icons-react";
import type { Session } from "../../server/schema.ts";
import { SessionKind } from "../../shared/types.ts";
import { confirm } from "../confirm.tsx";
import { useStore } from "../store.ts";

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
  // icon and running state, so repeating "remote" next to it was pure noise.
  return (
    <Group gap="xs" wrap="nowrap">
      {isRemote ? (
        <>
          {session.url && (
            <Anchor
              href={session.url}
              target="_blank"
              size="sm"
              fw={500}
              style={{ display: "inline-flex", alignItems: "center", gap: 3 }}
            >
              session <IconExternalLink size={13} />
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
        onClick={async () => {
          if (
            await confirm({
              message:
                "Stop this session? The agent is killed, its worktree discarded, and the task returns to pending.",
              title: "Stop session",
              confirmLabel: "Stop session",
              danger: true,
            })
          )
            stop(session.id);
        }}
      >
        Stop
      </Button>
    </Group>
  );
}
