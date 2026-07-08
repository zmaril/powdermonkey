// The live event feed for disponent-managed (Remote) sessions — additive observation
// that replaces the "remote workers surface only through PR comments" gap. disponent
// emits a per-session event stream (State/Message/ToolCall/ToolResult/Log/Artifact/Raw,
// plus Usage which the meters own — see disponent-usage.ts); this poller drains the
// non-Usage events past each session's feed cursor and appends them to session_events,
// which the browser mirrors live onto the worker card. It NEVER gates progress —
// completion still reads off main's trailers. When disponent emits nothing, the feed
// honestly stays empty.
//
// It rides the SAME lazy engine singleton exe.dev / the usage poller use (getDisponent)
// and shares the drain pump + PollDeps seam with disponent-usage.ts, so there's one
// engine, one drain, and one injectable surface for tests.

import type { Event, EventKind } from "@disponent/node";
import { eq } from "drizzle-orm";
import {
  type SessionEventFidelity,
  type SessionEventKind,
  sessionEventFidelity,
  sessionEventKind,
} from "../shared/session-events.ts";
import { db as realDb } from "./db.ts";
import {
  drainSessionEvents,
  forEachRemoteVmSession,
  liveRemoteVmSessions,
  type PollDeps,
} from "./disponent-usage.ts";
import { getDisponent, sessionForVm } from "./exe-dev.ts";
import { sessionEvents, sessions } from "./schema.ts";

/** The event kinds the LIVE FEED carries — everything disponent emits EXCEPT Usage,
 *  which the usage meters drain on their own path. Kept in one place so the drain and
 *  any future filter agree. */
// disponent's EventKind is a string union; these are its tokens minus "usage".
export const FEED_KINDS: EventKind[] = [
  "state", // lint-allow-string: disponent EventKind token, not a pm enum
  "message", // lint-allow-string: disponent EventKind token, not a pm enum
  "tool_call", // lint-allow-string: disponent EventKind token, not a pm enum
  "tool_result", // lint-allow-string: disponent EventKind token, not a pm enum
  "log", // lint-allow-string: disponent EventKind token, not a pm enum
  "artifact", // lint-allow-string: disponent EventKind token, not a pm enum
  "raw", // lint-allow-string: disponent EventKind token, not a pm enum
];

/** One feed row ready to insert (minus its session id) — the string-mapped, persisted
 *  shape of a drained disponent event. */
export type FeedRow = {
  idx: number;
  kind: SessionEventKind;
  fidelity: SessionEventFidelity | null;
  payload: string;
  ts: string | null;
};

/** Fold a batch of drained disponent events into persistable feed rows — PURE and
 *  dependency-free so it's unit-testable without a live backend. Validates each
 *  EventKind/Fidelity token to its string form, keeps only events strictly past `afterIdx`
 *  (a belt-and-braces idempotency guard on top of the drain's own afterIdx), and
 *  reports the highest idx kept so the caller can advance its cursor. */
export function feedRowsFromEvents(
  events: Event[],
  afterIdx: number | null,
): { rows: FeedRow[]; maxIdx: number | null } {
  const rows: FeedRow[] = [];
  let maxIdx: number | null = null;
  for (const ev of events) {
    if (afterIdx !== null && ev.idx <= afterIdx) continue; // never re-insert past the cursor
    rows.push({
      idx: ev.idx,
      kind: sessionEventKind(ev.kind),
      fidelity: sessionEventFidelity(ev.fidelity),
      payload: ev.payload,
      ts: ev.ts ?? null,
    });
    if (maxIdx === null || ev.idx > maxIdx) maxIdx = ev.idx;
  }
  return { rows, maxIdx };
}

const defaultDeps: PollDeps = { db: realDb, getDisponent, sessionForVm };

/** One feed-poll tick: for every live remote pm session backed by a worker VM, resolve
 *  its disponent session, drain the non-Usage events past the stored feed cursor,
 *  append them to session_events, and advance sessions.eventFeedCursor. Best-effort —
 *  each session's work is wrapped so one failure can't abort the tick (mirroring
 *  pollDisponentUsage / exe.dev's teardown discipline). No-op when no such session
 *  exists. Shares the engine singleton + PollDeps seam with the usage poller. */
export async function pollDisponentFeed(deps: PollDeps = defaultDeps): Promise<void> {
  const { db, getDisponent: getD, sessionForVm: forVm } = deps;

  const rows = await db
    .select({
      id: sessions.id,
      vmName: sessions.vmName,
      cursor: sessions.eventFeedCursor,
    })
    .from(sessions)
    .where(liveRemoteVmSessions());

  await forEachRemoteVmSession(
    { getDisponent: getD, sessionForVm: forVm },
    rows,
    "disponent-feed",
    async (row, d, dsession) => {
      const events = await drainSessionEvents(d, dsession.uid, row.cursor ?? undefined, FEED_KINDS);
      const { rows: feedRows, maxIdx } = feedRowsFromEvents(events, row.cursor ?? null);
      if (feedRows.length === 0) return;
      await db.insert(sessionEvents).values(feedRows.map((r) => ({ ...r, sessionId: row.id })));
      await db
        .update(sessions)
        .set({ eventFeedCursor: maxIdx ?? row.cursor })
        .where(eq(sessions.id, row.id));
    },
  );
}
