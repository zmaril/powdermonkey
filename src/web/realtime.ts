import { useEffect } from "react";
import { useStore } from "./store.ts";

// Client side of the realtime feed. We open one WebSocket to /events and refetch
// the store snapshot on every push, replacing the old 4s poll. The wire payload is
// a content-free "changed" ping — the server is the single writer, so "something
// moved, re-read everything" is all the client needs.
//
// Reconnect is best-effort: if the socket drops while the server is alive (a proxy
// idle-timeout, say) we retry with a short backoff and refetch on reopen so we
// never miss a change that happened while we were disconnected. A server restart is
// handled separately by App's /health watch, which reloads the page once it's back.

const RECONNECT_MS = 2000;

/** Subscribe to server-pushed changes for the lifetime of the component, refetching
 *  the store on connect and on every ping. */
export function useRealtime(): void {
  const refresh = useStore((s) => s.refresh);
  useEffect(() => {
    let closed = false;
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (closed) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/events`);
      // Pull a fresh snapshot on (re)connect so we start aligned and catch anything
      // missed while disconnected.
      ws.onopen = () => void refresh();
      ws.onmessage = () => void refresh();
      ws.onclose = () => {
        if (closed) return;
        retry = setTimeout(connect, RECONNECT_MS);
      };
      // An errored socket also fires onclose; let that path own the reconnect.
      ws.onerror = () => ws?.close();
    };
    connect();

    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      ws?.close();
    };
  }, [refresh]);
}
