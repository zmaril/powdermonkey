import { Button, Group } from "@mantine/core";
import { IconCloud, IconDeviceLaptop, IconPlayerPlayFilled } from "@tabler/icons-react";
import { useState } from "react";
import { SessionKind } from "../../../shared/types.ts";
import { useStore } from "../../store.ts";
import { LaunchButton } from "./LaunchButton.tsx";

// Icon clusters for the launch buttons: target (laptop / cloud) + a play glyph.
const LOCAL_ICON = (
  <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
    <IconDeviceLaptop size={15} />
    <IconPlayerPlayFilled size={10} />
  </span>
);
const REMOTE_ICON = (
  <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
    <IconCloud size={15} />
    <IconPlayerPlayFilled size={10} />
  </span>
);

/** The shared action cluster for a backlog task (or a whole multi-selection): launch
 *  local (laptop) / remote (cloud) — each with an optional run note — or close it
 *  (DONE / WONTDO). Works on one or many ids — the solo card passes `[task.id]`, the
 *  batch bar passes the selection. `onDone` clears the selection after an action. */
export function TaskActions({ ids, onDone }: { ids: number[]; onDone?: () => void }) {
  const { startLocalMany, dispatchMany, completeTask, cancelTask } = useStore();
  const [running, setRunning] = useState<SessionKind | null>(null);
  const busy = running !== null;

  const launch = async (kind: SessionKind, comment: string) => {
    if (busy || ids.length === 0) return;
    setRunning(kind);
    try {
      if (kind === SessionKind.Local) await startLocalMany(ids, comment);
      else await dispatchMany(ids, comment);
      onDone?.();
    } finally {
      setRunning(null);
    }
  };
  const markDone = () => {
    for (const id of ids) completeTask(id);
    onDone?.();
  };
  const wontDo = () => {
    const msg =
      ids.length > 1
        ? `Close ${ids.length} tasks as won't-do? They move to the archive as cancelled.`
        : "Close this task as won't-do? It moves to the archive as cancelled.";
    if (window.confirm(msg)) {
      for (const id of ids) cancelTask(id);
      onDone?.();
    }
  };

  return (
    <Group gap="xs" wrap="nowrap" style={{ flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
      <LaunchButton
        icon={LOCAL_ICON}
        label="Start local"
        loading={running === SessionKind.Local}
        disabled={busy}
        onRun={(c) => launch(SessionKind.Local, c)}
      />
      <LaunchButton
        icon={REMOTE_ICON}
        label="Dispatch remote"
        color="cyan"
        loading={running === SessionKind.Remote}
        disabled={busy}
        onRun={(c) => launch(SessionKind.Remote, c)}
      />
      <Button
        size="compact-xs"
        variant="light"
        color="orange"
        title="Mark this task done by hand"
        onClick={markDone}
      >
        DONE
      </Button>
      <Button
        size="compact-xs"
        variant="light"
        color="red"
        title="Close as won't-do (archived, not counted as done)"
        onClick={wontDo}
      >
        WONTDO
      </Button>
    </Group>
  );
}
