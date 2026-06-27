import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";

// xterm.js wired to the /pty WebSocket. Server sends binary PTY output; we send
// JSON input/resize frames back. Pass `session` to attach to a local session's
// long-lived agent PTY; otherwise `cwd` opens a fresh shell at that path.
export function ShellTerminal({ cwd, session }: { cwd?: string; session?: number }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const term = new Terminal({
      fontSize: 13,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      theme: { background: "#1a1b1e" },
      cursorBlink: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();

    const proto = location.protocol === "https:" ? "wss" : "ws";
    const qs =
      session != null ? `?session=${session}` : cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    const ws = new WebSocket(`${proto}://${location.host}/pty${qs}`);
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
    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) term.write(new Uint8Array(e.data));
    };
    ws.onclose = () => term.write("\r\n\x1b[2m[session closed]\x1b[0m\r\n");

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
          const res = await fetch("/upload", { method: "POST", body });
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
      ro.disconnect();
      el.removeEventListener("dragover", onDragOver);
      el.removeEventListener("drop", onDrop);
      ws.close();
      term.dispose();
    };
  }, [cwd, session]);

  return <div ref={ref} style={{ height: "100%", width: "100%" }} />;
}
