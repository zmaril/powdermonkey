import { Badge, Button, Group, SegmentedControl, Stack, Text } from "@mantine/core";
import { IconCloudUpload } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { SyncMode } from "../../../shared/types.ts";
import { api } from "../../client.ts";
import { useStore } from "../../store.ts";
import { timeAgo } from "../../time.ts";

// Data-durability autosync: on every store change, a logical snapshot is committed to
// one durable branch (see docs/backups.md). This control sets the mode (off / local /
// push) and surfaces the live sync status polled from /backup/status. "Back up to a
// PR" is the on-demand counterpart — a point-in-time snapshot opened as its own PR.

type SyncStatus = {
  mode: string;
  branch: string;
  lastSyncedAt: string | null;
  lastCommit: string | null;
  pushed: boolean;
  rows: number | null;
  lastError: string | null;
  syncing: boolean;
  pending: boolean;
};

const MODES = [
  { key: SyncMode.Off, label: "Off" },
  { key: SyncMode.Local, label: "Local" },
  { key: SyncMode.Push, label: "Push" },
];

export function SyncControl() {
  const syncMode = useStore((s) => s.syncMode);
  const setSyncMode = useStore((s) => s.setSyncMode);
  const setError = useStore((s) => s.setError);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [exporting, setExporting] = useState(false);

  // Poll the live sync status — it's server runtime state, not a synced collection.
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const { data } = await api.backup.status.get();
      if (alive && data) setStatus(data as SyncStatus);
    };
    load();
    const id = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const exportToPr = async () => {
    setExporting(true);
    try {
      const { data, error } = await api.backup.export.post({ target: "pr" });
      if (error) {
        setError(String(error.value ?? error.status));
        return;
      }
      const url = (data as { prUrl?: string | null } | null)?.prUrl;
      if (url) window.open(url, "_blank", "noopener");
    } finally {
      setExporting(false);
    }
  };

  return (
    <Stack gap="snug">
      <Text size="sm" fw={600}>
        Backup sync
      </Text>
      <Text size="xs" c="dimmed">
        Snapshot the store on every change and commit it to one durable branch. Local keeps it in
        git on this machine; Push also sends it to the repo. Recover with{" "}
        <Text span ff="monospace" size="xs">
          powdermonkey restore --branch {status?.branch ?? "powdermonkey-backup"}
        </Text>
        .
      </Text>
      <SegmentedControl
        size="xs"
        value={syncMode}
        onChange={setSyncMode}
        data={MODES.map((m) => ({ label: m.label, value: m.key }))}
        style={{ alignSelf: "flex-start" }}
      />
      {syncMode !== SyncMode.Off && (
        <Group gap="sm" wrap="nowrap">
          <Badge size="sm" variant="light" color={status?.lastError ? "red" : "teal"}>
            {status?.lastError
              ? "error"
              : status?.syncing
                ? "syncing…"
                : status?.pending
                  ? "pending"
                  : "idle"}
          </Badge>
          <Text size="xs" c="dimmed">
            {status?.lastError
              ? status.lastError
              : status?.lastSyncedAt
                ? `last synced ${timeAgo(status.lastSyncedAt)} → ${status.branch}${
                    status.rows != null ? ` (${status.rows} rows)` : ""
                  }`
                : `waiting for the first change → ${status?.branch ?? ""}`}
          </Text>
        </Group>
      )}
      <Group gap="sm">
        <Button
          size="compact-sm"
          variant="default"
          leftSection={<IconCloudUpload size={15} />}
          loading={exporting}
          onClick={exportToPr}
        >
          Back up to a PR
        </Button>
        <Text size="xs" c="dimmed">
          A one-off snapshot on its own branch, opened as a PR.
        </Text>
      </Group>
      {status?.lastCommit && !status.lastError && (
        <Text size="xs" c="dimmed">
          latest commit{" "}
          <Text span ff="monospace" size="xs">
            {status.lastCommit.slice(0, 8)}
          </Text>
          {status.pushed ? " (pushed)" : " (local)"}
        </Text>
      )}
    </Stack>
  );
}
