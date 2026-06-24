// Right pane: the always-on chat surface, as a tabbed workspace. Each open chat
// is a tab (auto-updating title); ✕ archives it, the Archive button reopens an
// archived one, and ＋ starts a new chat. Below the tab strip is the active
// conversation + composer.

import {
  useThreadIsEmpty,
  useThreadListItemArchive,
  useThreadListItemUnarchive,
  useThreadListNew,
} from "@assistant-ui/core/react";
import {
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  ThreadPrimitive,
  useAui,
} from "@assistant-ui/react";
import {
  ActionIcon,
  Box,
  Button,
  Divider,
  Group,
  Loader,
  Menu,
  ScrollArea,
  Stack,
  Text,
  UnstyledButton,
} from "@mantine/core";
import { useEffect, useState } from "react";
import { useBoard } from "../store.ts";
import { Composer } from "./Composer.tsx";
import { MessageList } from "./Messages.tsx";
import { useRunStatus } from "./run-status.ts";

// One open chat = one tab. data-active is set by assistant-ui on the active one
// (styled in markdown.css). The ✕ archives the chat (removing the tab).
function ChatTab() {
  const { archive } = useThreadListItemArchive();
  return (
    <ThreadListItemPrimitive.Root className="pm-tab">
      <ThreadListItemPrimitive.Trigger asChild>
        <UnstyledButton style={{ overflow: "hidden", maxWidth: 150 }}>
          <Text size="xs" truncate>
            <ThreadListItemPrimitive.Title fallback="New chat" />
          </Text>
        </UnstyledButton>
      </ThreadListItemPrimitive.Trigger>
      <ActionIcon
        size="xs"
        variant="subtle"
        color="gray"
        aria-label="Close chat"
        className="pm-tab-close"
        onClick={(e) => {
          e.stopPropagation();
          archive();
        }}
      >
        ✕
      </ActionIcon>
    </ThreadListItemPrimitive.Root>
  );
}

// A row in the Archive dropdown. Clicking it unarchives (reopens as a tab) and
// switches to it.
function ArchivedRow() {
  const { unarchive } = useThreadListItemUnarchive();
  return (
    <ThreadListItemPrimitive.Root>
      <ThreadListItemPrimitive.Trigger asChild>
        <Menu.Item onClick={() => unarchive()} leftSection={<Text span>↻</Text>}>
          <Text size="sm" truncate maw={220}>
            <ThreadListItemPrimitive.Title fallback="New chat" />
          </Text>
        </Menu.Item>
      </ThreadListItemPrimitive.Trigger>
    </ThreadListItemPrimitive.Root>
  );
}

// Lets the operator point the active supervisor chat at a workspace (or none).
// Polls the active thread id since assistant-ui switches the main thread
// imperatively; clearing the workspace returns the chat to a loose assistant.
function WorkspaceSwitcher() {
  const aui = useAui();
  const board = useBoard((s) => s.board);
  const workspaces = board?.workspaces ?? [];
  const reloadBoard = useBoard((s) => s.load);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [wsId, setWsId] = useState<string | null>(null);

  useEffect(() => {
    const read = () => {
      try {
        setThreadId(aui.threadListItem().getState().remoteId ?? null);
      } catch {
        setThreadId(null);
      }
    };
    read();
    const i = setInterval(read, 600);
    return () => clearInterval(i);
  }, [aui]);

  useEffect(() => {
    if (!threadId) {
      setWsId(null);
      return;
    }
    let live = true;
    fetch(`/api/threads/${threadId}`)
      .then((r) => r.json())
      .then((t) => {
        if (live) setWsId(t?.workspaceId ?? null);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [threadId]);

  const choose = async (id: string | null) => {
    if (!threadId) return;
    setWsId(id);
    await fetch(`/api/threads/${threadId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: id }),
    });
    await reloadBoard();
  };

  if (!threadId) return null;
  const current = workspaces.find((w) => w.id === wsId);
  return (
    <Menu position="bottom-start" withinPortal shadow="md" width={220}>
      <Menu.Target>
        <Button
          size="compact-xs"
          variant="subtle"
          color={current ? "orange" : "gray"}
          leftSection={<Text span>⌖</Text>}
        >
          {current ? current.name : "No workspace"}
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>Supervisor workspace</Menu.Label>
        <Menu.Item onClick={() => choose(null)}>No workspace (general)</Menu.Item>
        {workspaces.map((w) => (
          <Menu.Item key={w.id} onClick={() => choose(w.id)}>
            {w.name}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}

function RunningIndicator() {
  const running = useRunStatus((s) => s.running);
  const hasText = useRunStatus((s) => s.hasText);
  const startedAt = useRunStatus((s) => s.startedAt);
  const tools = useRunStatus((s) => s.tools);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const i = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(i);
  }, [running]);
  if (!running) return null;
  if (hasText && tools.length === 0) return null;
  const secs = Math.max(0, Math.round((now - startedAt) / 1000));
  return (
    <Box px="md" py="sm">
      <Group gap="xs" mb={tools.length ? 6 : 0}>
        <span className="pm-spark">✻</span>
        <Text size="sm" c="dimmed">
          {tools.length ? "Working" : "Thinking"} · {secs}s
        </Text>
      </Group>
      {tools.length > 0 && (
        <Stack gap={4} pl={6}>
          {tools.map((t) => (
            <Group key={t.id} gap={8} wrap="nowrap">
              {t.done ? (
                <Text span c="teal" size="xs">
                  ✓
                </Text>
              ) : (
                <Loader size={11} color="gray" />
              )}
              <Text size="xs" c={t.done ? "dimmed" : "gray.3"}>
                {t.name}
              </Text>
            </Group>
          ))}
        </Stack>
      )}
    </Box>
  );
}

function ThreadArea() {
  const isEmpty = useThreadIsEmpty();
  return (
    <ThreadPrimitive.Root
      style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}
    >
      {isEmpty ? (
        <>
          <Box style={{ flex: 1 }} />
          <Text size="sm" c="dimmed" ta="center" px="md" mb="sm">
            Ask the assistant, or open a supervisor chat from a goal.
          </Text>
          <Box px="sm" pb="sm">
            <Composer />
          </Box>
        </>
      ) : (
        <>
          <ThreadPrimitive.Viewport
            style={{ flex: 1, overflowY: "auto", minHeight: 0, padding: "10px 12px" }}
          >
            <MessageList />
            <RunningIndicator />
          </ThreadPrimitive.Viewport>
          <Box px="sm" pb="sm" pt="xs">
            <Composer />
          </Box>
        </>
      )}
    </ThreadPrimitive.Root>
  );
}

export function RightPane() {
  const { switchToNewThread } = useThreadListNew();
  return (
    <Stack h="100%" gap={0}>
      <Group
        gap={6}
        wrap="nowrap"
        px="xs"
        py={5}
        style={{ borderBottom: "1px solid var(--mantine-color-dark-4)" }}
      >
        <ScrollArea
          type="hover"
          scrollbarSize={4}
          style={{ flex: 1 }}
          styles={{ viewport: { paddingBottom: 2 } }}
        >
          <ThreadListPrimitive.Root className="pm-tabstrip">
            <ThreadListPrimitive.Items>{() => <ChatTab />}</ThreadListPrimitive.Items>
          </ThreadListPrimitive.Root>
        </ScrollArea>

        <Menu position="bottom-end" withinPortal shadow="md" width={260}>
          <Menu.Target>
            <ActionIcon variant="subtle" color="gray" size="md" aria-label="Archived chats">
              🗄
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Label>Archived chats</Menu.Label>
            <ThreadListPrimitive.Root>
              <ThreadListPrimitive.Items archived>
                {() => <ArchivedRow />}
              </ThreadListPrimitive.Items>
            </ThreadListPrimitive.Root>
          </Menu.Dropdown>
        </Menu>

        <Button
          size="compact-sm"
          variant="light"
          color="orange"
          onClick={() => switchToNewThread()}
        >
          ＋ New
        </Button>
      </Group>

      <Box px="xs" py={3} style={{ borderBottom: "1px solid var(--mantine-color-dark-5)" }}>
        <WorkspaceSwitcher />
      </Box>
      <ThreadArea />
    </Stack>
  );
}
