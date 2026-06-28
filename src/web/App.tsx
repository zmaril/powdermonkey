import { Button, Divider, Group, Stack, Text, Title } from "@mantine/core";
import "dockview-core/dist/styles/dockview.css";
import { useLiveQuery } from "@tanstack/react-db";
import {
  type DockviewApi,
  DockviewReact,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
  themeAbyss,
} from "dockview-react";
import { useEffect, useRef, useState } from "react";
import { SessionState } from "../shared/types.ts";
import { AboutPane } from "./AboutPane.tsx";
import { ActivePane } from "./ActivePane.tsx";
import { ArchivePane } from "./ArchivePane.tsx";
import { BacklogPane } from "./BacklogPane.tsx";
import { BrowserPane } from "./BrowserPane.tsx";
import { HelpPane } from "./HelpPane.tsx";
import { PlanReviewPane } from "./PlanReviewPane.tsx";
import { ReviewPane } from "./ReviewPane.tsx";
import { SettingsPane } from "./SettingsPane.tsx";
import { ShellTerminal } from "./ShellTerminal.tsx";
import { ActivityTab, useTabActivity } from "./TabActivity.tsx";
import {
  notesCollection,
  sessionTasksCollection,
  sessionsCollection,
  tasksCollection,
} from "./collections.ts";
import { useNeedsInputNotifications } from "./notifications.ts";
import { useStore } from "./store.ts";

// The single pane of glass. The plan is split into three panels — a live ACTIVE
// monitor, a launchpad BACKLOG editor, and the ARCHIVE book of work — alongside
// the scratchpad and the supervisor shell. Every panel renders off TanStack DB
// collections (collections.ts) that sync themselves live from PGlite over /sync —
// no store data, no poll, no refetch (see plan-data.ts).

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
  // The scratch note as the notes collection keeps it (synced live from PGlite).
  // Watching it lets out-of-band edits (another tab, or the supervisor editing
  // @notes) show up.
  const notes = useLiveQuery(() => notesCollection);
  const storeBody = id == null ? undefined : notes.data?.find((n) => n.id === id)?.body;

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

function BrowserPanel(props: IDockviewPanelProps<{ url: string }>) {
  const rememberBrowserUrl = useStore((s) => s.rememberBrowserUrl);
  // Persist a navigation two ways: into this panel's params (so the layout, which is
  // serialized and saved, brings the URL back on reload) and into the store's
  // last-used URL (so the next fresh Browser pane opens where you left off).
  const onNavigate = (url: string) => {
    props.api.updateParameters({ url });
    rememberBrowserUrl(url);
  };
  return <BrowserPane url={props.params.url ?? ""} onNavigate={onNavigate} />;
}

function SettingsPanel() {
  return <SettingsPane />;
}

function AboutPanel() {
  return <AboutPane />;
}

function HelpPanel() {
  return <HelpPane />;
}

function PlanReviewPanel() {
  return <PlanReviewPane />;
}

const dockComponents = {
  shell: ShellPanel,
  active: ActivePanel,
  backlog: BacklogPanel,
  archive: ArchivePanel,
  scratch: ScratchPanel,
  browser: BrowserPanel,
  settings: SettingsPanel,
  about: AboutPanel,
  help: HelpPanel,
  planreview: PlanReviewPanel,
};

// Tab titles for the singleton panes opened by the top-bar launchers (openPane →
// paneReq). Component name and panel id are the same string as the pane id.
const PANE_TITLES: Record<string, string> = {
  active: "Active",
  backlog: "Backlog",
  archive: "Archive",
  scratch: "Scratch",
  settings: "Settings",
  about: "About",
  help: "Help",
  planreview: "Plan",
};

// Reviewing a PR is a focused, take-over activity, not another tab competing for the
// split — so the Review pane renders as a full-window overlay above everything (top
// bar included), driven by store.review. Esc or the pane's Close button drops back
// to the workspace. Esc is ignored while typing so it can't eat a comment draft.
function ReviewOverlay() {
  const review = useStore((s) => s.review);
  const closeReview = useStore((s) => s.closeReview);
  useEffect(() => {
    if (!review) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t instanceof HTMLTextAreaElement || t instanceof HTMLInputElement;
      if (e.key === "Escape" && !typing) closeReview();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [review, closeReview]);
  if (!review) return null;
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "#1a1b1e",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <ReviewPane number={review.number} onClose={closeReview} />
    </div>
  );
}

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
    id: "archive", // lint-allow-string: dockview panel id, not an enum value
    component: "archive", // lint-allow-string: dockview component name, not an enum value
    title: "Archive",
    position: { direction: "within", referencePanel: "active" },
  });
  api.addPanel({
    id: "planreview",
    component: "planreview",
    title: "Plan",
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
    title: "supervisor", // lint-allow-string: shell panel title, not the decision source
    position: { direction: "below", referencePanel: "scratch" },
  });
  // Show Active first (adding Backlog "within" would otherwise leave it focused).
  active.api.setActive();
}

// A top-bar button that opens (or focuses) a pane. The whole top bar is now just
// these launchers — one per pane type — so summoning any pane is the same gesture.
function PaneButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button size="compact-xs" variant="default" onClick={onClick}>
      {label}
    </Button>
  );
}

// Slim global toolbar: the app title, the error banner, and a launcher for every
// pane type. Click one and the pane appears (or comes forward) below — singletons
// focus their one instance, Shell/Browser open a fresh one each time. Lives above
// the dockview so it's always reachable regardless of which panel is focused.
function TopBar() {
  const openPane = useStore((s) => s.openPane);
  const openTerminal = useStore((s) => s.openTerminal);
  const openBrowser = useStore((s) => s.openBrowser);
  const error = useStore((s) => s.error);
  // "loading" until the first collection snapshot lands.
  const loading = useLiveQuery(() => tasksCollection).isLoading;
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
          <PaneButton label="Active" onClick={() => openPane("active")} />
          <PaneButton label="Backlog" onClick={() => openPane("backlog")} />
          <PaneButton
            label="Archive"
            onClick={
              () => openPane("archive") /* lint-allow-string: pane id, not ProposalOp.Archive */
            }
          />
          <PaneButton label="Plan" onClick={() => openPane("planreview")} />
          <Divider orientation="vertical" />
          <PaneButton label="Shell" onClick={() => openTerminal("")} />
          <PaneButton label="Browser" onClick={() => openBrowser()} />
          <PaneButton label="Scratch" onClick={() => openPane("scratch")} />
          <Divider orientation="vertical" />
          <PaneButton label="Settings" onClick={() => openPane("settings")} />
          <PaneButton label="About" onClick={() => openPane("about")} />
          <PaneButton label="Help" onClick={() => openPane("help")} />
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
  const browserReq = useStore((s) => s.browserReq);
  const paneReq = useStore((s) => s.paneReq);
  const setLayout = useStore((s) => s.setLayout);
  const loadSettings = useStore((s) => s.loadSettings);

  // The plan/session data flows through the TanStack DB collections (each syncs
  // itself over /sync). The only server state not in a collection is the auto-rebase
  // toggle, so fetch that once on mount.
  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  // Ping the operator (OS notification) whenever a session falls idle at a prompt.
  // Watches the sessions collection, firing only on the needs_input edge.
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

  // Browser button → add a new browser pane (an iframe on a dev server / preview).
  // Each request opens a distinct panel (keyed by `n`) so you can watch several
  // previews at once; the loaded URL rides in the panel params so it persists with
  // the layout. Added in the main group, alongside Active/Backlog/Archive.
  useEffect(() => {
    const api = apiRef.current;
    if (!browserReq) return;
    api?.addPanel({
      id: `browser-${browserReq.n}`,
      component: "browser",
      params: { url: browserReq.url },
      title: "Browser",
      position: { referencePanel: "active", direction: "within" },
    });
  }, [browserReq]);

  // A pane-launcher button → focus the singleton pane if it's already open, else add
  // it. New panes land "within" the main group (next to Active/Backlog/Archive) when
  // that anchor exists, otherwise wherever dockview puts a group-less panel — so a
  // launcher always brings the pane up even if the default layout was torn apart.
  useEffect(() => {
    const api = apiRef.current;
    if (!paneReq || !api) return;
    const existing = api.getPanel(paneReq.id);
    if (existing) {
      existing.api.setActive();
      return;
    }
    const anchor = api.getPanel("active") ? "active" : api.panels[0]?.id;
    api.addPanel({
      id: paneReq.id,
      component: paneReq.id,
      title: PANE_TITLES[paneReq.id] ?? paneReq.id,
      position: anchor ? { referencePanel: anchor, direction: "within" } : undefined,
    });
  }, [paneReq]);

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
      <ReviewOverlay />
    </div>
  );
}
