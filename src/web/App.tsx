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
import { ActivityTab, useTabActivity } from "./TabActivity.tsx";
import { useNeedsInputNotifications, useNotificationPermission } from "./notifications.ts";
import { useRealtime } from "./realtime.ts";
import { useStore } from "./store.ts";

// The single pane of glass. The plan is split into three panels — a live ACTIVE
// monitor, a launchpad BACKLOG editor, and the ARCHIVE book of work — alongside
// the scratchpad and the supervisor shell. A WebSocket change feed (useRealtime)
// refetches the store on every server push, keeping the live panels' store-derived
// views fresh (Archive runs its own slower poll for archived rows); the panes
// themselves are pure derivations off the store (see plan-data.ts).

// The scratchpad: one note, one big textarea. Holds its own draft state seeded
// once from the server so a background refetch can't clobber what you're typing;
// edits update the draft immediately and debounce a PATCH. The supervisor reads it
// on "check @notes" (GET /notes).
function ScratchPad() {
  const { ensureScratch, saveNote } = useStore();
  const [id, setId] = useState<number | null>(null);
  const [body, setBody] = useState("");
  const [saved, setSaved] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The server value we're synced with. We only adopt an incoming change when the
  // local draft still equals this — i.e. there are no unsaved keystrokes to lose.
  const serverBody = useRef("");
  // The scratch note as the background refetch keeps it in the store. Watching it
  // lets out-of-band edits (another tab, or the supervisor editing @notes) show up.
  const storeBody = useStore((s) =>
    id == null ? undefined : s.notes.find((n) => n.id === id)?.body,
  );

  useEffect(() => {
    let active = true;
    ensureScratch().then((note) => {
      if (!active || !note) return;
      setId(note.id);
      setBody(note.body);
      serverBody.current = note.body;
    });
    return () => {
      active = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [ensureScratch]);

  // Adopt a server-side change (poll / out-of-band CRUD) only when nothing local
  // is pending — if the draft has diverged, the operator is mid-edit; don't clobber.
  useEffect(() => {
    if (storeBody != null && storeBody !== body && body === serverBody.current) {
      setBody(storeBody);
      serverBody.current = storeBody;
    }
  }, [storeBody, body]);

  const onChange = (next: string) => {
    setBody(next);
    if (id == null) return;
    setSaved(false);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      saveNote(id, { body: next }).then(() => {
        serverBody.current = next;
        setSaved(true);
      });
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

// The dock layout is store state (useStore.layout), persisted by the store's
// `persist` middleware so the disconnect→reload recovery (and any plain browser
// refresh) keeps your panes — rearrangements, opened shells, the lot — instead of
// snapping back to the default. App mirrors that state onto the dockview api:
// onReady restores it, and onDidLayoutChange writes every change back via setLayout.

// The default arrangement, built from scratch when there's no saved layout (or a
// saved one we couldn't restore): Active/Backlog/Archive tabs in the main group,
// the scratchpad over the supervisor shell on the left.
function buildDefaultLayout(api: DockviewApi) {
  const active = api.addPanel({ id: "active", component: "active", title: "Active" });
  api.addPanel({
    id: "backlog",
    component: "backlog",
    title: "Backlog",
    position: { direction: "within", referencePanel: "active" },
  });
  api.addPanel({
    id: "archive",
    component: "archive",
    title: "Archive",
    position: { direction: "within", referencePanel: "active" },
  });
  api.addPanel({
    id: "scratch",
    component: "scratch",
    title: "Scratch",
    position: { direction: "left", referencePanel: "active" },
  });
  api.addPanel({
    id: "shell-0",
    component: "shell",
    params: { cwd: "", session: null },
    title: "supervisor",
    position: { direction: "below", referencePanel: "scratch" },
  });
  // Show Active first (adding Backlog "within" would otherwise leave it focused).
  active.api.setActive();
}

// Opt into OS web notifications. Browsers only grant permission on a user gesture,
// so this is an explicit button; once granted/denied it reflects the standing
// state (and there's nothing more to do — the choice is the browser's to keep).
function NotifyButton() {
  const { permission, request } = useNotificationPermission();
  if (permission === "unsupported") return null;
  const label =
    permission === "granted" ? "🔔 On" : permission === "denied" ? "🔕 Blocked" : "🔔 Notify";
  return (
    <Button
      size="compact-xs"
      variant="default"
      onClick={request}
      disabled={permission !== "default"}
      title={
        permission === "granted"
          ? "Desktop notifications are on — you'll be pinged when a session needs you"
          : permission === "denied"
            ? "Notifications are blocked in your browser settings"
            : "Enable desktop notifications when a session needs you"
      }
    >
      {label}
    </Button>
  );
}

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
          <NotifyButton />
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
  const layoutSubRef = useRef<{ dispose: () => void } | null>(null);
  const shellReq = useStore((s) => s.shellReq);
  const notesReq = useStore((s) => s.notesReq);
  const setLayout = useStore((s) => s.setLayout);

  // The whole app stays fresh off server pushes: useRealtime opens one WebSocket
  // to /events, refetches the store on connect and on every "changed" ping, and
  // reconnects if the socket drops. That replaced the old 4s poll — every panel
  // renders off the store, so a single refetch on push keeps them all current.
  useRealtime();

  // Ping the operator (OS notification) whenever a session falls idle at a prompt.
  // Watches the same store the panes do, firing only on the needs_input edge.
  useNeedsInputNotifications();

  // In-app glanceable layer: light up a pane's tab when something happens in it
  // while its tab is off screen (new session, needs-you, task status change). The
  // tab clears itself when viewed. apiRef is set in onReady below.
  useTabActivity(apiRef);

  const onReady = (event: DockviewReadyEvent) => {
    apiRef.current = event.api;
    // Restore the layout from the store (rehydrated from localStorage by persist);
    // otherwise lay out the default. A corrupt/incompatible saved layout (or one
    // that restores to nothing) falls back to the default so a reload can never
    // leave you staring at a blank dock.
    const saved = useStore.getState().layout;
    let restored = false;
    if (saved) {
      try {
        event.api.fromJSON(saved);
        restored = event.api.panels.length > 0;
      } catch {
        restored = false;
      }
    }
    if (!restored) buildDefaultLayout(event.api);
    // Mirror every layout change back into the store — add/move/close a panel,
    // resize, focus a tab — so it persists and the next load (notably the
    // disconnect→reload) comes back as-is. Subscribed after the initial build so
    // restoring doesn't write over what we just restored.
    layoutSubRef.current = event.api.onDidLayoutChange(() => setLayout(event.api.toJSON()));
  };

  // Tear the layout subscription down with the component.
  useEffect(() => () => layoutSubRef.current?.dispose(), []);

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
        <DockviewReact
          components={dockComponents}
          defaultTabComponent={ActivityTab}
          onReady={onReady}
          theme={themeAbyss}
        />
      </div>
    </div>
  );
}
