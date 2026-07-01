import { useEffect, useRef, useState } from "react";
import { apiUrl } from "../server.ts";

// Heartbeat the server's /health. When it drops (typically a `bun --watch`
// restart) and then comes back, reload the page once to reconnect cleanly —
// fresh bundle, new /pty WebSockets, fresh poll. A full reload resets all state,
// so the recovery is inherently one-shot (no reload loop). Returns whether we're
// currently disconnected, for a banner.
export function useConnectionWatch(): boolean {
  const [disconnected, setDisconnected] = useState(false);
  const wasDown = useRef(false);
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const res = await fetch(apiUrl("/health"), { cache: "no-store" });
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
