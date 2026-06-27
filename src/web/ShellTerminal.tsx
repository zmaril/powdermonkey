import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";

// xterm.js wired to the supervisor's /pty WebSocket. Server sends binary PTY
// output; we send JSON input/resize frames back.
export function ShellTerminal({ cwd }: { cwd?: string }) {
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
    const qs = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
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

    const ro = new ResizeObserver(() => {
      fit.fit();
      sendResize();
    });
    ro.observe(el);

    return () => {
      onData.dispose();
      ro.disconnect();
      ws.close();
      term.dispose();
    };
  }, [cwd]);

  return <div ref={ref} style={{ height: "100%", width: "100%" }} />;
}
