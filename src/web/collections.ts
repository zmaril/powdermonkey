import { createCollection } from "@tanstack/db";
import type { CloudPr } from "../server/events.ts";
import type {
  Goal,
  Milestone,
  Note,
  Phase,
  Proposal,
  Repo,
  Session,
  SessionEvent,
  Task,
  TaskComment,
} from "../server/schema.ts";
import type { SessionLink } from "./active.ts";
import { wsUrl } from "./server.ts";

// The browser mirrors each server table as a TanStack DB collection, synced over the
// /sync WebSocket from PGlite's `live.changes` (server stays embedded PGlite — see
// app.ts). Reads are reactive live queries; there is no per-table sync code beyond the
// one-line registrations at the bottom. Writes still go through the REST routes (no
// optimism for now) and stream back here as deltas, so the UI updates without a refetch.

type Op = "INSERT" | "UPDATE" | "DELETE" | "RESET";
type Delta = Record<string, unknown> & { __op__: Op; __changed_columns__: string[] };

// PGlite speaks the DB's snake_case; Drizzle's row types are camelCase. The mapping is
// exactly snake→camel (that's how Drizzle derives column names), so this is lossless.
const toCamel = (s: string): string => s.replace(/_([a-z])/g, (_m, c) => c.toUpperCase());

/** Strip change metadata (__op__, __after__, …) and camel-case the remaining columns. */
function toRow(delta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(delta)) if (!k.startsWith("__")) out[toCamel(k)] = v;
  return out;
}

/** Register one server table as a live-synced collection. `key` is the primary-key
 *  property (camelCase). Everything else — the socket, snapshot, and delta mapping —
 *  is generic. */
function syncedCollection<T extends object>(table: string, key: keyof T & string) {
  return createCollection<T, number>({
    id: table,
    getKey: (row) => row[key] as number,
    sync: {
      // UPDATE deltas are partial (only changed columns); TanStack merges them onto
      // the existing row instead of overwriting with the nulls PGlite sends for the
      // unchanged ones.
      rowUpdateMode: "partial",
      sync: ({ begin, write, commit, markReady, truncate }) => {
        const ws = new WebSocket(wsUrl(`/sync?table=${table}`));
        let ready = false;
        const ensureReady = () => {
          if (ready) return;
          ready = true;
          markReady();
        };
        ws.onmessage = (e) => {
          const { changes } = JSON.parse(e.data) as { changes: Delta[] };
          begin();
          for (const c of changes) {
            const row = toRow(c);
            if (c.__op__ === "RESET") {
              truncate();
            } else if (c.__op__ === "DELETE") {
              write({ type: "delete", key: row[key] as number });
            } else if (c.__op__ === "INSERT") {
              write({ type: "insert", value: row as T });
            } else {
              // UPDATE — apply only the changed columns plus the key (for getKey).
              const cols = c.__changed_columns__.filter((x) => !x.startsWith("__")).map(toCamel);
              if (cols.length === 0) continue; // ordering-only churn
              const value: Record<string, unknown> = { [key]: row[key] };
              for (const col of cols) value[col] = row[col];
              write({ type: "update", value: value as T }); // lint-allow-string: TanStack DB change type, not a ProposalOp
            }
          }
          commit();
          ensureReady(); // first frame is the snapshot — the collection is now ready
        };
        ws.onerror = ensureReady; // never strand the collection in "loading"
        return () => ws.close();
      },
    },
  });
}

// ── The registrations: one line per table, types straight from the Drizzle schema ──
export const goalsCollection = syncedCollection<Goal>("goals", "id");
export const milestonesCollection = syncedCollection<Milestone>("milestones", "id");
export const tasksCollection = syncedCollection<Task>("tasks", "id");
export const phasesCollection = syncedCollection<Phase>("phases", "id");
export const sessionsCollection = syncedCollection<Session>("sessions", "id");
export const sessionEventsCollection = syncedCollection<SessionEvent>("session_events", "id");
export const sessionTasksCollection = syncedCollection<SessionLink & { id: number }>(
  "session_tasks",
  "id",
);
export const taskCommentsCollection = syncedCollection<TaskComment>("task_comments", "id");
export const notesCollection = syncedCollection<Note>("notes", "id");
export const reposCollection = syncedCollection<Repo>("repos", "id");
export const pullRequestsCollection = syncedCollection<CloudPr>("pull_requests", "number");
export const proposalsCollection = syncedCollection<Proposal>("proposals", "id");
