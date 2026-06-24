// The Workspaces management page (middle pane): see every workspace, edit its
// dir/secrets/env config, and create new ones.

import { Box, Button, Card, Code, Collapse, Group, Stack, Text, Title } from "@mantine/core";
import { useState } from "react";
import { useBoard } from "../store.ts";
import {
  emptyWorkspaceFields,
  parseWorkspaceExtras,
  WorkspaceFields,
  type WorkspaceFieldsValue,
} from "../WorkspaceFields.tsx";

type Workspace = NonNullable<ReturnType<typeof useBoard.getState>["board"]>["workspaces"][number];

function toFields(w: Workspace): WorkspaceFieldsValue {
  return {
    name: w.name ?? "",
    repoPath: w.repoPath ?? "",
    subpath: w.subpath ?? "",
    secretsText: Object.entries(w.secrets ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
    envFilesText: (w.envFiles ?? []).join("\n"),
    setup: w.setup ?? "",
  };
}

function payload(form: WorkspaceFieldsValue) {
  return {
    name: form.name.trim(),
    repoPath: form.repoPath.trim() || null,
    ...parseWorkspaceExtras(form),
  };
}

function WorkspaceCard({ w }: { w: Workspace }) {
  const reload = useBoard((s) => s.load);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<WorkspaceFieldsValue>(() => toFields(w));
  const save = async () => {
    await fetch(`/api/workspaces/${w.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload(form)),
    });
    setEditing(false);
    await reload();
  };
  const archive = async () => {
    await fetch(`/api/workspaces/${w.id}/archive`, { method: "POST" });
    await reload();
  };
  return (
    <Card withBorder padding="md" radius="md">
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <Box>
          <Text fw={600}>{w.name}</Text>
          {w.repoPath ? (
            <Code>{w.repoPath}</Code>
          ) : (
            <Text size="xs" c="dimmed">
              no repo path
            </Text>
          )}
        </Box>
        <Group gap="xs">
          <Button
            size="xs"
            variant="light"
            onClick={() => {
              setForm(toFields(w));
              setEditing((e) => !e);
            }}
          >
            {editing ? "Cancel" : "Edit"}
          </Button>
          <Button size="xs" variant="subtle" color="gray" onClick={archive}>
            Archive
          </Button>
        </Group>
      </Group>
      <Collapse in={editing}>
        <Stack mt="md" gap="sm">
          <WorkspaceFields value={form} onChange={setForm} />
          <Group justify="flex-end">
            <Button color="orange" onClick={save} disabled={!form.name.trim()}>
              Save
            </Button>
          </Group>
        </Stack>
      </Collapse>
    </Card>
  );
}

export function WorkspacesView() {
  const board = useBoard((s) => s.board);
  const reload = useBoard((s) => s.load);
  const workspaces = board?.workspaces ?? [];
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(emptyWorkspaceFields);
  const create = async () => {
    if (!form.name.trim()) return;
    await fetch("/api/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload(form), repoPath: form.repoPath.trim() || undefined }),
    });
    setForm(emptyWorkspaceFields);
    setCreating(false);
    await reload();
  };
  return (
    <Box p="xl" style={{ overflowY: "auto", height: "100%" }}>
      <Group justify="space-between" mb="md">
        <Title order={3} style={{ fontFamily: "Georgia, serif" }}>
          Workspaces
        </Title>
        <Button color="orange" onClick={() => setCreating((c) => !c)}>
          {creating ? "Cancel" : "＋ New workspace"}
        </Button>
      </Group>
      <Collapse in={creating}>
        <Card withBorder padding="md" radius="md" mb="md">
          <Stack gap="sm">
            <WorkspaceFields value={form} onChange={setForm} />
            <Group justify="flex-end">
              <Button color="orange" onClick={create} disabled={!form.name.trim()}>
                Create workspace
              </Button>
            </Group>
          </Stack>
        </Card>
      </Collapse>
      <Stack gap="sm">
        {workspaces.length === 0 ? (
          <Text c="dimmed" size="sm">
            No workspaces yet. Create one to point PowderMonkey at a repo.
          </Text>
        ) : (
          workspaces.map((w) => <WorkspaceCard key={w.id} w={w} />)
        )}
      </Stack>
    </Box>
  );
}
