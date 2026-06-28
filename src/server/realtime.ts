// A WebSocket fan-out for "the plan/session state changed — refetch". The browser
// subscribes once and refetches its snapshot on every push, replacing the old 4s
// poll; the wire payload stays a trivial ping, so there's nothing to keep in sync
// diff-by-diff.
//
// The CHANGE SOURCE is the database itself. PGlite's `live` extension installs
// per-table triggers that fire on every INSERT/UPDATE/DELETE (see db.ts), so a
// single live query per table tells us whenever that table moves — no matter which
// code path wrote it. That means mutations no longer announce themselves by hand;
// startChangeFeed() watches the tables and the WS fan-out reacts. (The one
// exception is the cloud-PR CI/mergeable status, which the github-watch loop holds
// in memory rather than the DB; it calls notifyChange() directly.)
//
// The fan-out half is kept framework-free (no Elysia import) so it's unit-testable:
// the .ws route in app.ts registers each socket's send function here.

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

// ---- DB change feed --------------------------------------------------------

// The vocab/runtime tables the UI reads. A live query on each fires its callback
// whenever that table changes (insert/update/delete via any path), which is our cue
// to ping clients. Adding a table here is all it takes to make it realtime.
const WATCHED_TABLES = [
  "goals",
  "milestones",
  "tasks",
  "phases",
  "sessions",
  "session_tasks",
  "notes",
] as const;

/** The slice of the PGlite client the feed needs — just `live.query`. Structural so
 *  realtime.ts stays decoupled from the concrete PGlite type (and easy to fake). */
export type LiveQueryHandle = { unsubscribe: () => Promise<void> };
export type LivePg = {
  live: {
    query(
      query: string,
      params: unknown[] | null,
      callback: (results: unknown) => void,
    ): Promise<LiveQueryHandle>;
  };
};

let feedHandles: LiveQueryHandle[] | null = null;

/** Watch every table the UI reads and ping clients on each change. Idempotent: a
 *  second call while the feed is live is a no-op. Call after migrations have run so
 *  the tables (and thus the live triggers) exist. */
export async function startChangeFeed(pg: LivePg): Promise<void> {
  if (feedHandles) return;
  const handles: LiveQueryHandle[] = [];
  for (const table of WATCHED_TABLES) {
    // `live.query` invokes the callback once with the initial results at subscribe
    // time; skip that prime so booting doesn't broadcast before anything changed.
    let primed = false;
    const handle = await pg.live.query(`SELECT count(*)::int AS n FROM ${table}`, [], () => {
      if (!primed) {
        primed = true;
        return;
      }
      notifyChange();
    });
    handles.push(handle);
  }
  feedHandles = handles;
}

/** Tear the feed down (tests / shutdown). */
export async function stopChangeFeed(): Promise<void> {
  if (!feedHandles) return;
  const handles = feedHandles;
  feedHandles = null;
  for (const h of handles) {
    try {
      await h.unsubscribe();
    } catch {}
  }
}
