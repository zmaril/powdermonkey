import { createCollection } from "@tanstack/db";

// SPIKE — the embedded local-first path, proven on one table.
//   server PGlite live.changes  →  /sync/pull-requests WebSocket  →  this collection
// The server stays embedded PGlite; row deltas (insert/update/delete) stream here and
// feed a reactive TanStack DB collection via begin/write/commit. Reads are live; this
// table is read-only in the UI (the github-watch loop is its only writer), so there's
// no optimistic write path — that's a deliberate scope cut for the spike.

export type SyncedPr = {
  number: number;
  taskId: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  merged: boolean;
  checks: string | null;
  mergeable: string | null;
};

// A PGlite `live.changes` delta: the (possibly partial) row columns plus metadata.
type PrChange = Partial<SyncedPr> & {
  number: number;
  __op__: "INSERT" | "UPDATE" | "DELETE" | "RESET";
  __changed_columns__: string[];
};

// PGlite folds change metadata (__op__, __after__, __changed_columns__) into the row;
// drop every __-prefixed key to recover the clean record.
function stripMeta(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) if (!k.startsWith("__")) out[k] = v;
  return out;
}

export const pullRequestsCollection = createCollection<SyncedPr, number>({
  id: "pull_requests",
  getKey: (pr) => pr.number,
  sync: {
    // An UPDATE delta carries only the changed columns (the rest arrive null), so we
    // hand TanStack a partial value and let it merge onto the existing row.
    rowUpdateMode: "partial",
    sync: ({ begin, write, commit, markReady, truncate }) => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/sync/pull-requests`);
      let ready = false;
      const ensureReady = () => {
        if (ready) return;
        ready = true;
        markReady();
      };
      ws.onmessage = (e) => {
        const { changes } = JSON.parse(e.data) as { changes: PrChange[] };
        begin();
        for (const c of changes) {
          if (c.__op__ === "RESET") {
            truncate();
          } else if (c.__op__ === "DELETE") {
            write({ type: "delete", key: c.number });
          } else if (c.__op__ === "INSERT") {
            write({ type: "insert", value: stripMeta(c) as SyncedPr });
          } else {
            // UPDATE — apply only the changed data columns (partial merge).
            const cols = c.__changed_columns__.filter((col) => !col.startsWith("__"));
            if (cols.length === 0) continue; // ordering-only churn, nothing to apply
            const value: Record<string, unknown> = { number: c.number };
            for (const col of cols) value[col] = (c as Record<string, unknown>)[col];
            write({ type: "update", value: value as SyncedPr });
          }
        }
        commit();
        ensureReady(); // first frame is the snapshot — collection is now ready
      };
      // Don't strand the collection in "loading" if the socket can't open.
      ws.onerror = ensureReady;
      return () => ws.close();
    },
  },
});
