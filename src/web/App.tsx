import { Button, Group, Text, Title } from "@mantine/core";
import "dockview-core/dist/styles/dockview.css";
import {
  type DockviewApi,
  DockviewReact,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
  themeAbyss,
} from "dockview-react";
import { useEffect, useRef, useState } from "react";
import { ActivePane } from "./ActivePane.tsx";
import { ArchivePane } from "./ArchivePane.tsx";
import { BacklogPane } from "./BacklogPane.tsx";
import { ShellTerminal } from "./ShellTerminal.tsx";
import { useStore } from "./store.ts";

// The single pane of glass. The plan is split into three panels — a live ACTIVE
// monitor, a launchpad BACKLOG editor, and the ARCHIVE book of work — alongside
// the scratchpad and the supervisor shell. One poll (here) keeps the live panels'
// store-derived views fresh (Archive runs its own slower poll for archived rows);
// the panes themselves are pure derivations off the store (see plan-data.ts).

// The scratchpad: one note, one big textarea. Holds its own draft state seeded
// once from the server so the 4s background poll can't clobber what you're typing;
// edits update the draft immediately and debounce a PATCH. The supervisor reads it
// on "check @notes" (GET /notes).
function ScratchPad() {
  const { ensureScratch, saveNote } = useStore();
  const [id, setId] = useState<number | null>(null);
  const [body, setBody] = useState("");
  const [saved, setSaved] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let active = true;
    ensureScratch().then((note) => {
      if (!active || !note) return;
      setId(note.id);
      setBody(note.body);
    });
    return () => {
      active = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [ensureScratch]);

  const onChange = (next: string) => {
    setBody(next);
    if (id == null) return;
    setSaved(false);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      saveNote(id, { body: next }).then(() => setSaved(true));
    }, 500);
  };

  return (
    <div
      style={{ height: "100%", display: "flex", flexDirection: "column", background: "#1a1b1e" }}
    >
      <Group justify="space-between" px="sm" py={6} style={{ flex: "0 0 auto" }}>
        <Text size="xs" c="dimmed" fw={700} style={{ letterSpacing: 0.5 }}>
          SCRATCH
        </Text>
        <Text size="xs" c="dimmed">
          {id == null ? "…" : saved ? "saved" : "saving…"}
        </Text>
      </Group>
      <textarea
        value={body}
        onChange={(e) => onChange(e.currentTarget.value)}
        placeholder="Stray thoughts…"
        spellCheck={false}
        style={{
          flex: 1,
          width: "100%",
          resize: "none",
          border: "none",
          outline: "none",
          background: "#1a1b1e",
          color: "#c1c2c5",
          padding: "4px 12px 12px",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: 13,
          lineHeight: 1.5,
        }}
      />
    </div>
  );
}

function ShellPanel(props: IDockviewPanelProps<{ cwd: string; session: number | null }>) {
  return (
    <div style={{ height: "100%", width: "100%", background: "#1a1b1e" }}>
      <ShellTerminal
        cwd={props.params.cwd || undefined}
        session={props.params.session ?? undefined}
      />
    </div>
  );
}

function ActivePanel() {
  return <ActivePane />;
}

function BacklogPanel() {
  return <BacklogPane />;
}

function ArchivePanel() {
  return <ArchivePane />;
}

function ScratchPanel() {
  return <ScratchPad />;
}

const dockComponents = {
  shell: ShellPanel,
  active: ActivePanel,
  backlog: BacklogPanel,
  archive: ArchivePanel,
  scratch: ScratchPanel,
};

// Slim global toolbar: the app title, the cross-cutting actions (Shell / Scratch /
// Reconcile), and the error banner. Lives above the dockview so it's always visible
// regardless of which panel is focused.
function TopBar() {
  const { error, loading, reconcile, openTerminal, openNotes } = useStore();
  return (
    <div style={{ flex: "0 0 auto", borderBottom: "1px solid #2c2e33", background: "#141517" }}>
      <Group justify="space-between" px="md" py={6} wrap="nowrap">
        <Group gap="sm" wrap="nowrap">
          <Title order={5}>PowderMonkey</Title>
          {loading && (
            <Text size="xs" c="dimmed">
              loading…
            </Text>
          )}
          {error && (
            <Text size="xs" c="red" truncate maw={420} title={error}>
              {error}
            </Text>
          )}
        </Group>
        <Group gap={6} wrap="nowrap">
          <Button size="compact-xs" variant="default" onClick={() => openTerminal("")}>
            Shell
          </Button>
          <Button size="compact-xs" variant="default" onClick={openNotes}>
            Scratch
          </Button>
          <Button size="compact-xs" variant="default" onClick={reconcile}>
            Reconcile
          </Button>
        </Group>
      </Group>
    </div>
  );
}

// Heartbeat the server's /health. When it drops (typically a `bun --watch`
// restart) and then comes back, reload the page once to reconnect cleanly —
// fresh bundle, new /pty WebSockets, fresh poll. A full reload resets all state,
// so the recovery is inherently one-shot (no reload loop). Returns whether we're
// currently disconnected, for a banner.
function useConnectionWatch(): boolean {
  const [disconnected, setDisconnected] = useState(false);
  const wasDown = useRef(false);
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const res = await fetch("/health", { cache: "no-store" });
        if (!res.ok) throw new Error(`health ${res.status}`);
        if (cancelled) return;
        if (wasDown.current) {
          window.location.reload();
          return;
        }
        setDisconnected(false);
      } catch {
        if (cancelled) return;
        wasDown.current = true;
        setDisconnected(true);
      }
    };
    check();
    const id = setInterval(check, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);
  return disconnected;
}

function DisconnectBanner() {
  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 10000,
        background: "#b54708",
        color: "#fff",
        textAlign: "center",
        padding: "5px 10px",
        fontSize: 13,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      }}
    >
      Disconnected from the supervisor — reconnecting, will refresh when it's back…
    </div>
  );
}

export function App() {
  const apiRef = useRef<DockviewApi | null>(null);
  const shellReq = useStore((s) => s.shellReq);
  const notesReq = useStore((s) => s.notesReq);
  const refresh = useStore((s) => s.refresh);

  // The one poll for the whole app. Every panel renders off the store, so this
  // keeps Active/Backlog/Scratch current as branches land and sessions change.
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 4000);
    return () => clearInterval(id);
  }, [refresh]);

  const onReady = (event: DockviewReadyEvent) => {
    apiRef.current = event.api;
    // Layout: Active + Backlog + Archive as tabs in the main (right) group; the
    // left column is the scratchpad over the supervisor shell.
    const active = event.api.addPanel({ id: "active", component: "active", title: "Active" });
    event.api.addPanel({
      id: "backlog",
      component: "backlog",
      title: "Backlog",
      position: { direction: "within", referencePanel: "active" },
    });
    event.api.addPanel({
      id: "archive",
      component: "archive",
      title: "Archive",
      position: { direction: "within", referencePanel: "active" },
    });
    event.api.addPanel({
      id: "scratch",
      component: "scratch",
      title: "Scratch",
      position: { direction: "left", referencePanel: "active" },
    });
    event.api.addPanel({
      id: "shell-0",
      component: "shell",
      params: { cwd: "", session: null },
      title: "supervisor",
      position: { direction: "below", referencePanel: "scratch" },
    });
    // Show Active first (adding Backlog "within" would otherwise leave it focused).
    active.api.setActive();
  };

  // Each open*Terminal() adds (or focuses) a shell panel keyed by shellReq.key.
  useEffect(() => {
    const api = apiRef.current;
    if (!shellReq || !api) return;
    const id = shellReq.key === "repo" ? "shell-0" : `shell-${shellReq.key}`;
    const existing = api.getPanel(id);
    if (existing) {
      existing.api.setActive();
      return;
    }
    api.addPanel({
      id,
      component: "shell",
      params: { cwd: shellReq.cwd, session: shellReq.session },
      // Session panels show the bare tag (LOCAL · PM/TASK-35); plain shells keep
      // a "shell · " prefix to set them apart.
      title: shellReq.session != null ? shellReq.title : `shell · ${shellReq.title}`,
      position: { referencePanel: "shell-0", direction: "within" },
    });
  }, [shellReq]);

  // Scratch button → focus the scratchpad (recreate it top-left if it was closed).
  useEffect(() => {
    const api = apiRef.current;
    if (!notesReq || !api) return;
    const existing = api.getPanel("scratch");
    if (existing) {
      existing.api.setActive();
      return;
    }
    api.addPanel({
      id: "scratch",
      component: "scratch",
      title: "Scratch",
      position: { referencePanel: "active", direction: "left" },
    });
  }, [notesReq]);

  const disconnected = useConnectionWatch();

  return (
    <div style={{ height: "100vh", width: "100vw", display: "flex", flexDirection: "column" }}>
      {disconnected && <DisconnectBanner />}
      <TopBar />
      <div style={{ flex: 1, minHeight: 0 }}>
        <DockviewReact components={dockComponents} onReady={onReady} theme={themeAbyss} />
      </div>
    </div>
  );
}
