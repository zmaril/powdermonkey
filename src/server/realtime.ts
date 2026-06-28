// A tiny WebSocket fan-out for "the plan/session state changed — refetch". The
// supervisor is the single writer of all plan/session state, so instead of the
// browser polling on a timer, every mutation calls notifyChange() and the server
// pushes a one-shot ping to each connected client. The client reacts by refetching
// its snapshot (the same GET-everything refresh the old poll ran), so the wire
// payload stays trivial and there's nothing to keep in sync diff-by-diff.
//
// Kept framework-free (no Elysia import) so it's unit-testable: the .ws route in
// app.ts registers each socket's send function here and drops it on close.

type Send = (msg: string) => void;

// Keyed by a stable per-socket identity (Elysia's ws.raw) so open/close pair up
// even if the wrapper object differs between callbacks.
const clients = new Map<object, Send>();

/** Register a connected client's send function. */
export function addRealtimeClient(key: object, send: Send): void {
  clients.set(key, send);
}

/** Drop a client on socket close. */
export function removeRealtimeClient(key: object): void {
  clients.delete(key);
}

/** Number of live subscribers — for tests and diagnostics. */
export function realtimeClientCount(): number {
  return clients.size;
}

// The only message we send: a content-free "something changed" ping. The client
// owns deciding what to refetch.
export const CHANGED_MESSAGE = JSON.stringify({ type: "changed" });

let scheduled = false;

/** Signal that some plan/session state changed. Coalesces a burst of writes (a
 *  plan load, a multi-row update) into a single ping on the next tick — every
 *  change in the window is covered because the client refetches everything. */
export function notifyChange(): void {
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => {
    scheduled = false;
    broadcast(CHANGED_MESSAGE);
  }, 30);
}

/** Send a raw message to every connected client now. A throwing socket (closing
 *  mid-send) is skipped, never breaking the fan-out. */
export function broadcast(msg: string): void {
  for (const send of clients.values()) {
    try {
      send(msg);
    } catch {}
  }
}
