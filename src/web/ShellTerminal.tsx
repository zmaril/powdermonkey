import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { type RefObject, useEffect, useRef } from "react";
import { fontScaleOption } from "./appearance.ts";
import { openExternal } from "./open-external.ts";
import { PmIdDecorator } from "./pm-id-decorate.ts";
import { PmIdLinkProvider } from "./pm-id-links.ts";
import { apiUrl, wsUrl } from "./server.ts";
import { useActiveTheme, useStore } from "./store.ts";
import { MONO } from "./theme.ts";
import type { EditorTheme } from "./themes.ts";

// The accent colour (a #RRGGBB hex) the PM-id links are tinted with — the same accent the
// cursor uses. xterm decorations only accept #RRGGBB, which the palette tuples already are.
function accentHex(t: EditorTheme): string {
  return t.accent[t.primaryShade];
}

// The xterm theme for an editor palette. Crucially sets `foreground` (the palette's
// primary text) — xterm defaults it to white, which renders white-on-white on the light
// themes whose terminal background is white/cream. Cursor follows the accent, selection
// the theme's wash.
function xtermThemeOf(t: EditorTheme) {
  return {
    background: t.terminalBg,
    foreground: t.dark[0],
    cursor: t.accent[t.primaryShade],
    cursorAccent: t.terminalBg,
    selectionBackground: t.selection,
  };
}

// The whole xterm engine wired to the /pty WebSocket, as a hook so no effect lives in
// the ShellTerminal component file. Returns the container ref to attach. Server sends
// binary PTY output; we send JSON input/resize frames back. `session` attaches to a
// local session's long-lived agent PTY; otherwise `cwd` opens a fresh shell there.
// `onEnded` fires when the server signals the attached session is gone for good.
export function useShellTerminal(
  cwd: string | undefined,
  session: number | undefined,
  onEnded: (() => void) | undefined,
): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null);
  // Keep the latest onEnded without re-running the socket effect on every render.
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;
  // The terminal follows the active editor theme. Build a full xterm theme — not just
  // the background — so the shell stays readable in every theme; read it through a ref
  // so a theme change re-skins the live terminal (effect below) without re-running the
  // socket effect — that owns the PTY WebSocket and must stay stable.
  const editor = useActiveTheme();
  const themeRef = useRef(xtermThemeOf(editor));
  themeRef.current = xtermThemeOf(editor);
  // The terminal font follows the font-size control (13px base × the scale factor),
  // updated live below without re-running the socket effect.
  const fontPx = Math.round(13 * fontScaleOption(useStore((s) => s.fontScale)).factor);
  const fontRef = useRef(fontPx);
  fontRef.current = fontPx;
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const decoRef = useRef<PmIdDecorator | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const term = new Terminal({
      fontSize: fontRef.current,
      fontFamily: MONO,
      lineHeight: 1.15,
      theme: themeRef.current,
      cursorBlink: true,
      // Marker + decoration APIs (used by PmIdDecorator to persistently style PM ids) are
      // still "proposed" in xterm and throw unless this is opted into.
      allowProposedApi: true,
    });
    termRef.current = term;
    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
    // Detect URLs in the output and render them as clickable links. openExternal
    // opens a new tab in the browser and hands off to the OS default browser in
    // the desktop shell; either way the opened page can't reach back into this one.
    term.loadAddon(
      new WebLinksAddon((_ev, uri) => {
        openExternal(uri);
      }),
    );
    // The PM-id counterpart to the URL links above: scan the same PTY output for
    // t/p/m/g/s id tokens and render them hover-underlined. Clicking one reveals the
    // entity in the UI. This is registered on every terminal — the supervisor shell and
    // each worker's session PTY — so an id jumps to its entity whoever printed it.
    const linkProvider = term.registerLinkProvider(
      new PmIdLinkProvider(term, (kind, id) => {
        useStore.getState().revealEntity(kind, id);
      }),
    );
    term.open(el);
    fit.fit();
    // Persistent styling for the PM-id links: blue + underlined at all times (the link
    // provider above only underlines on hover). Tinted with the theme accent (the xterm
    // theme's `cursor` is that same accent hex), re-skinned by the theme effect below.
    const decorator = new PmIdDecorator(term, themeRef.current.cursor);
    decoRef.current = decorator;

    const qs =
      session != null ? `?session=${session}` : cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    const ws = new WebSocket(wsUrl(`/pty${qs}`));
    ws.binaryType = "arraybuffer";

    const sendResize = () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      }
    };

    ws.onopen = () => {
      fit.fit();
      sendResize();
      term.focus();
    };
    // The session ended for good — once we've seen this, the close that follows is
    // expected, not a dropped connection, so suppress the "[session closed]" line.
    let ended = false;
    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(e.data));
        return;
      }
      // Text frame = a control message (not PTY output).
      try {
        const msg = JSON.parse(String(e.data)) as { type?: string };
        if (msg.type === "session-ended") {
          ended = true;
          term.write("\r\n\x1b[2m[this session has ended]\x1b[0m\r\n");
          onEndedRef.current?.();
        }
      } catch {}
    };
    ws.onclose = () => {
      if (!ended) term.write("\r\n\x1b[2m[session closed]\x1b[0m\r\n");
    };

    const onData = term.onData((d) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "input", data: d }));
    });

    // Shift+Enter inserts a newline instead of submitting. Claude Code binds
    // newline to Ctrl+J (0x0A), which passes cleanly through tmux — unlike the
    // kitty-protocol CSI-u sequence, which needs extended-keys setup. So on
    // Shift+Enter send a bare LF and tell xterm not to also send a CR (submit).
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type === "keydown" && ev.key === "Enter" && ev.shiftKey) {
        // preventDefault is essential: it stops xterm's follow-up keypress from
        // also emitting a carriage return (which submits) and stops the hidden
        // textarea's own newline. Without it, Shift+Enter sends "\n" AND "\r" —
        // which looks fine on an empty line but submits once you've typed text.
        ev.preventDefault();
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "input", data: "\n" }));
        }
        return false;
      }
      return true;
    });

    // Drag an image in → upload it to the supervisor, then type its server-side
    // absolute path into the PTY. Claude Code detects image extensions and
    // attaches them; the browser is remote, so the file must land on the server
    // filesystem first.
    const onDragOver = (e: DragEvent) => e.preventDefault();
    const onDrop = async (e: DragEvent) => {
      e.preventDefault();
      const files = Array.from(e.dataTransfer?.files ?? []).filter((f) =>
        f.type.startsWith("image/"),
      );
      for (const file of files) {
        try {
          const body = new FormData();
          body.append("file", file);
          const res = await fetch(apiUrl("/upload"), { method: "POST", body });
          const { path } = (await res.json()) as { path?: string };
          if (path && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "input", data: `${path} ` }));
          }
        } catch {
          term.write("\r\n\x1b[31m[image upload failed]\x1b[0m\r\n");
        }
      }
    };
    el.addEventListener("dragover", onDragOver);
    el.addEventListener("drop", onDrop);

    const ro = new ResizeObserver(() => {
      fit.fit();
      sendResize();
    });
    ro.observe(el);

    return () => {
      onData.dispose();
      decorator.dispose();
      decoRef.current = null;
      linkProvider.dispose();
      ro.disconnect();
      el.removeEventListener("dragover", onDragOver);
      el.removeEventListener("drop", onDrop);
      ws.close();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [cwd, session]);

  // Re-skin / re-size the live terminal when the theme or font scale changes, without
  // touching the socket. Refit after a font-size change so the grid matches the pane.
  useEffect(() => {
    // `editor` (from getTheme) is a stable reference per theme key, so this re-skins
    // only when the selected theme actually changes.
    if (termRef.current) termRef.current.options.theme = xtermThemeOf(editor);
    decoRef.current?.setColor(accentHex(editor));
  }, [editor]);
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = fontPx;
    fitRef.current?.fit();
  }, [fontPx]);

  return ref;
}

// xterm.js wired to the /pty WebSocket. Pass `session` to attach to a local session's
// long-lived agent PTY; otherwise `cwd` opens a fresh shell at that path. `onEnded`
// fires when the server signals the attached session is gone for good. The whole
// engine lives in useShellTerminal (effects belong in hook files).
export function ShellTerminal({
  cwd,
  session,
  onEnded,
}: {
  cwd?: string;
  session?: number;
  onEnded?: () => void;
}) {
  const ref = useShellTerminal(cwd, session, onEnded);
  return <div ref={ref} style={{ height: "100%", width: "100%" }} />;
}
