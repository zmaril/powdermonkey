// Per-backend usage/cost meters, folded from disponent's event stream. This is
// purely additive observation: disponent emits Usage events on a session's
// timeline (token counts + fractional-cent cost, when its OTel receiver is wired —
// see PM_DISPONENT_OTEL_PORT in exe-dev.ts), and we accumulate them onto the pm
// session row so the status bar can show "how much has this backend spent". It
// NEVER feeds progress — completion still reads off main's trailers, agent- and
// engine-agnostic. When disponent emits nothing, the meters honestly read 0.
//
// The engine is the SAME lazy singleton exe.dev provisioning uses (getDisponent):
// two Disponent instances on one SQLite sink would contend, so we never open a
// second one.

import { type Event, EventKind } from "@disponent/node";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { SessionKind } from "../shared/types.ts";
import { db as realDb } from "./db.ts";
import { getDisponent, sessionForVm } from "./exe-dev.ts";
import { sessions } from "./schema.ts";

/** Running usage totals for one session — the shape the reducer folds onto. */
export type UsageTotals = {
  inputTokens: number;
  outputTokens: number;
  costCents: number;
};

/** The reducer's result: the new totals plus the highest event idx it folded in
 *  (null when no Usage events were present), so the caller can advance its cursor. */
export type AccumulatedUsage = UsageTotals & { maxIdx: number | null };

/** Fold a batch of disponent events onto prior usage totals — PURE and
 *  dependency-free so it's unit-testable without a live backend. Only Usage
 *  events count; each carries a JSON `payload` that parses to a UsageDelta
 *  ({ inputTokens?, outputTokens?, costCents? }). Missing token fields default to
 *  0; `costCents` is a STRING decimal (fractional cents) summed as a number. The
 *  max event idx seen (across ALL events passed, so the cursor advances past
 *  non-Usage events too) is tracked; a malformed payload is skipped, never thrown. */
export function accumulateUsage(prev: UsageTotals, events: Event[]): AccumulatedUsage {
  let { inputTokens, outputTokens, costCents } = prev;
  let maxIdx: number | null = null;
  for (const ev of events) {
    if (maxIdx === null || ev.idx > maxIdx) maxIdx = ev.idx;
    if (ev.kind !== EventKind.Usage) continue;
    let delta: { inputTokens?: number; outputTokens?: number; costCents?: string };
    try {
      delta = JSON.parse(ev.payload);
    } catch {
      continue; // a garbled payload must never abort the fold
    }
    inputTokens += delta.inputTokens ?? 0;
    outputTokens += delta.outputTokens ?? 0;
    costCents += Number(delta.costCents ?? "0");
  }
  return { inputTokens, outputTokens, costCents, maxIdx };
}

/** Hard cap on drain iterations — disponent's `events(...).next()` is a poll
 *  stream we pump until it returns null, so a runaway backend can't spin us. */
const DRAIN_CAP = 10_000;

/** Drain the currently-available events for a disponent session after `afterIdx`, in
 *  order, restricted to `kinds`. Pumps `events(...).next()` until it resolves null.
 *  `kinds` defaults to [Usage] so the usage poller's behavior is unchanged; the feed
 *  poller (disponent-feed.ts) passes the complement so the two drains share one pump. */
export async function drainSessionEvents(
  d: ReturnType<typeof getDisponent>,
  sessionUid: string,
  afterIdx?: number,
  kinds: EventKind[] = [EventKind.Usage],
): Promise<Event[]> {
  const stream = d.events({ sessionUid, afterIdx, kinds });
  const out: Event[] = [];
  for (let i = 0; i < DRAIN_CAP; i++) {
    const ev = await stream.next();
    if (!ev) break;
    out.push(ev);
  }
  return out;
}

/** Drain the currently-available Usage events — the slice-3 default over the shared
 *  pump above. Kept as a named seam so the usage poller and its test read unchanged. */
export function drainUsageEvents(
  d: ReturnType<typeof getDisponent>,
  sessionUid: string,
  afterIdx?: number,
): Promise<Event[]> {
  return drainSessionEvents(d, sessionUid, afterIdx, [EventKind.Usage]);
}

/** Injectable seams — real implementations by default, overridable in tests. */
export type PollDeps = {
  db: typeof realDb;
  getDisponent: typeof getDisponent;
  sessionForVm: typeof sessionForVm;
};

const defaultDeps: PollDeps = { db: realDb, getDisponent, sessionForVm };

/** The predicate that selects a live, disponent-managed session backed by a worker VM:
 *  a non-archived Remote session with a vmName. Both poll loops (usage + feed) drive off
 *  exactly this set, so the definition of "a session worth draining" lives in one place. */
export function liveRemoteVmSessions() {
  return and(
    eq(sessions.kind, SessionKind.Remote),
    isNull(sessions.archivedAt),
    isNotNull(sessions.vmName),
  );
}

/** The shared poll-tick scaffolding both drains ride on: open the engine ONCE, then for
 *  each already-selected session resolve its disponent handle and hand it to `handle`.
 *  Best-effort — each row's work is wrapped so one failure can't abort the tick, and a
 *  row with no vmName or no resolvable disponent session is skipped. Factored out so the
 *  usage and feed pollers share one loop (one engine, one per-row discipline) and differ
 *  only in what they drain and persist. */
export async function forEachRemoteVmSession<Row extends { vmName: string | null }>(
  deps: Pick<PollDeps, "getDisponent" | "sessionForVm">,
  rows: Row[],
  label: string,
  handle: (
    row: Row,
    d: ReturnType<PollDeps["getDisponent"]>,
    dsession: NonNullable<Awaited<ReturnType<PollDeps["sessionForVm"]>>>,
  ) => Promise<void>,
): Promise<void> {
  if (rows.length === 0) return;
  const d = deps.getDisponent();
  for (const row of rows) {
    if (!row.vmName) continue;
    try {
      const dsession = await deps.sessionForVm(d, row.vmName);
      if (!dsession) continue;
      await handle(row, d, dsession);
    } catch (e) {
      console.warn(`${label}: poll ${row.vmName} (non-fatal): ${e}`);
    }
  }
}

/** One usage-poll tick: for every live remote pm session backed by a worker VM,
 *  resolve its disponent session, drain the Usage events past the stored cursor,
 *  accumulate onto the row's running totals, and persist. Best-effort — each
 *  session's work is wrapped so one failure can't abort the tick (mirroring
 *  gcOrphanedWorkers / exe.dev's teardown discipline). No-op when no such session
 *  exists (a pure local / claude-remote operator never touches the engine). */
export async function pollDisponentUsage(deps: PollDeps = defaultDeps): Promise<void> {
  const { db, getDisponent: getD, sessionForVm: forVm } = deps;

  const rows = await db
    .select({
      id: sessions.id,
      vmName: sessions.vmName,
      inputTokens: sessions.usageInputTokens,
      outputTokens: sessions.usageOutputTokens,
      costCents: sessions.usageCostCents,
      cursor: sessions.usageEventCursor,
    })
    .from(sessions)
    .where(liveRemoteVmSessions());

  await forEachRemoteVmSession(
    { getDisponent: getD, sessionForVm: forVm },
    rows,
    "disponent-usage",
    async (row, d, dsession) => {
      const events = await drainUsageEvents(d, dsession.uid, row.cursor ?? undefined);
      if (events.length === 0) return;
      const next = accumulateUsage(
        { inputTokens: row.inputTokens, outputTokens: row.outputTokens, costCents: row.costCents },
        events,
      );
      await db
        .update(sessions)
        .set({
          usageInputTokens: next.inputTokens,
          usageOutputTokens: next.outputTokens,
          usageCostCents: next.costCents,
          usageEventCursor: next.maxIdx ?? row.cursor,
        })
        .where(eq(sessions.id, row.id));
    },
  );
}

/** One backend's rolled-up usage: how many live sessions it has and their summed
 *  tokens + cost. `backend` is a SessionKind ("local" | "remote"). */
export type BackendUsage = {
  backend: SessionKind;
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
};

/** Aggregate non-archived sessions grouped by kind — the data behind
 *  `GET /backends/usage`. Every kind seen gets a row (even at zero), so the bar
 *  can decide what to show. */
export async function backendUsageSummary(db: typeof realDb = realDb): Promise<BackendUsage[]> {
  const rows = await db
    .select({
      kind: sessions.kind,
      inputTokens: sessions.usageInputTokens,
      outputTokens: sessions.usageOutputTokens,
      costCents: sessions.usageCostCents,
    })
    .from(sessions)
    .where(isNull(sessions.archivedAt));

  const byKind = new Map<SessionKind, BackendUsage>();
  for (const row of rows) {
    const acc = byKind.get(row.kind) ?? {
      backend: row.kind,
      sessions: 0,
      inputTokens: 0,
      outputTokens: 0,
      costCents: 0,
    };
    acc.sessions += 1;
    acc.inputTokens += row.inputTokens;
    acc.outputTokens += row.outputTokens;
    acc.costCents += row.costCents;
    byKind.set(row.kind, acc);
  }
  return [...byKind.values()];
}
