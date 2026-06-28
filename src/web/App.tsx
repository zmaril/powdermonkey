import { Button, Code, CopyButton, Group, Popover, Stack, Text, Title } from "@mantine/core";
import "dockview-core/dist/styles/dockview.css";
import {
  type DockviewApi,
  DockviewReact,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
  themeAbyss,
} from "dockview-react";
import { useEffect, useRef, useState } from "react";
import { SessionState } from "../shared/types.ts";
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
  // The server value we're synced with. We only adopt an incoming change when the
  // local draft still equals this — i.e. there are no unsaved keystrokes to lose.
  const serverBody = useRef("");
  // The scratch note as the 4s poll keeps it in the store. Watching it lets
  // out-of-band edits (another tab, or the supervisor editing @notes) show up here.
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

// Shown over a shell pane whose attached session has ended (landed / merged /
// stopped, or its agent exited) — see ShellTerminal's onEnded. Instead of a blank,
// dead terminal the operator gets a clear end-state and a way out: close the pane,
// open a fresh shell (at the session's worktree if it still exists, else the repo —
// the server falls back), or jump to the PR. PR / worktree are looked up from the
// store by session id; the session↔task join is returned for archived sessions too,
// so the PR link survives the session being archived on land/merge.
function SessionEndedOverlay({ sessionId, onClose }: { sessionId: number; onClose: () => void }) {
  const openTerminal = useStore((s) => s.openTerminal);
  const session = useStore(
    (s) =>
      s.sessions.find((x) => x.id === sessionId) ??
      s.archive.sessions.find((x) => x.id === sessionId),
  );
  const prUrl = useStore((s) => {
    const taskIds = new Set(
      s.sessionTasks.filter((l) => l.sessionId === sessionId).map((l) => l.taskId),
    );
    return (
      [...s.tasks, ...s.archive.tasks].find((t) => taskIds.has(t.id) && t.prUrl)?.prUrl ?? null
    );
  });
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
        background: "rgba(26,27,30,0.88)",
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
            >
              View PR ↗
            </Button>
          )}
        </Group>
      </Stack>
    </div>
  );
}

function ShellPanel(props: IDockviewPanelProps<{ cwd: string; session: number | null }>) {
  const [ended, setEnded] = useState(false);
  const session = props.params.session;
  return (
    <div style={{ height: "100%", width: "100%", background: "#1a1b1e", position: "relative" }}>
      <ShellTerminal
        cwd={props.params.cwd || undefined}
        session={session ?? undefined}
        onEnded={() => setEnded(true)}
      />
      {ended && session != null && (
        <SessionEndedOverlay sessionId={session} onClose={() => props.api.close()} />
      )}
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

// One command + a copy button. The shell can't reach into the operator's terminal
// to attach for them — all the UI can do is hand over the exact line to paste.
function CommandRow({ cmd, hint }: { cmd: string; hint: string }) {
  return (
    <div>
      <Group gap={6} wrap="nowrap" justify="space-between">
        <Code style={{ fontSize: 12 }}>{cmd}</Code>
        <CopyButton value={cmd}>
          {({ copied, copy }) => (
            <Button
              size="compact-xs"
              variant={copied ? "light" : "default"}
              color={copied ? "teal" : undefined}
              onClick={copy}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          )}
        </CopyButton>
      </Group>
      <Text size="xs" c="dimmed">
        {hint}
      </Text>
    </div>
  );
}

// "Attach" → a popover with the terminal command that opens the tmux dashboard
// (one pane per session + the server). The browser shell shows one agent at a
// time; this is how you watch the whole machine from your own terminal.
function AttachButton() {
  return (
    <Popover width={300} position="bottom-end" withArrow shadow="md">
      <Popover.Target>
        <Button size="compact-xs" variant="default">
          Attach
        </Button>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap={8}>
          <Text size="xs" c="dimmed">
            Open the tmux dashboard in your terminal — one pane per live session, plus the server:
          </Text>
          <CommandRow cmd="powdermonkey attach" hint="installed globally (npm i -g powdermonkey)" />
          <CommandRow cmd="bun run attach" hint="from a checkout" />
        </Stack>
      </Popover.Dropdown>
    </Popover>
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
          <Button size="compact-xs" variant="default" onClick={() => openTerminal("")}>
            Shell
          </Button>
          <AttachButton />
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
  const refresh = useStore((s) => s.refresh);
  const setLayout = useStore((s) => s.setLayout);

  // The one poll for the whole app. Every panel renders off the store, so this
  // keeps Active/Backlog/Scratch current as branches land and sessions change.
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 4000);
    return () => clearInterval(id);
  }, [refresh]);

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
        <DockviewReact components={dockComponents} onReady={onReady} theme={themeAbyss} />
      </div>
    </div>
  );
}
