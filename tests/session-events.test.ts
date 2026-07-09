import { expect, test } from "bun:test";
import { type Event, EventKind, Fidelity } from "@disponent/node";
import { FEED_KINDS, feedRowsFromEvents, pollDisponentFeed } from "../src/server/disponent-feed.ts";
import type { PollDeps } from "../src/server/disponent-usage.ts";
import { describeSessionEvent, SESSION_EVENT_KIND } from "../src/shared/session-events.ts";

// Slice 4 — the live event feed for disponent-managed sessions. Two pure surfaces are
// pinned here without any live backend: (1) describeSessionEvent, the shared renderer's
// single source of display truth, and (2) the feed drain/poll reducer, exercised through
// the same injectable PollDeps seam the usage poller uses.

// ── describeSessionEvent ────────────────────────────────────────────────────────

test("a message maps to its role + text", () => {
  const d = describeSessionEvent({
    kind: SESSION_EVENT_KIND.Message,
    payload: JSON.stringify({ role: "assistant", text: "hello there" }),
  });
  expect(d.label).toBe("assistant");
  expect(d.text).toBe("hello there");
  expect(d.mono).toBe(false);
});

test("a tool_call surfaces the tool name", () => {
  const d = describeSessionEvent({
    kind: SESSION_EVENT_KIND.ToolCall,
    payload: JSON.stringify({ tool: "bash", input: { cmd: "ls" } }),
  });
  expect(d.text).toContain("bash");
  expect(d.mono).toBe(false);
});

test("a tool_result reflects ok/tool + output", () => {
  const okd = describeSessionEvent({
    kind: SESSION_EVENT_KIND.ToolResult,
    payload: JSON.stringify({ tool: "bash", ok: true, output: "done" }),
  });
  expect(okd.icon).toBe("✓");
  expect(okd.text).toContain("bash");
  expect(okd.text).toContain("done");

  const failed = describeSessionEvent({
    kind: SESSION_EVENT_KIND.ToolResult,
    payload: JSON.stringify({ tool: "bash", ok: false }),
  });
  expect(failed.icon).toBe("✗");
});

test("a log maps to its line", () => {
  const d = describeSessionEvent({
    kind: SESSION_EVENT_KIND.Log,
    payload: JSON.stringify({ line: "building…" }),
  });
  expect(d.text).toBe("building…");
  expect(d.mono).toBe(false);
});

test("a scraped terminal raw frame is monospace; other raw sources are not", () => {
  const term = describeSessionEvent({
    kind: SESSION_EVENT_KIND.Raw,
    fidelity: "scraped",
    payload: JSON.stringify({ source: "terminal", data: "$ ls\r\nfile" }),
  });
  expect(term.mono).toBe(true);
  expect(term.text).toContain("file");

  const other = describeSessionEvent({
    kind: SESSION_EVENT_KIND.Raw,
    payload: JSON.stringify({ source: "stdout", data: "x" }),
  });
  expect(other.mono).toBe(false);
});

test("mono is set ONLY for a scraped terminal raw, never for other kinds", () => {
  for (const kind of [
    SESSION_EVENT_KIND.Message,
    SESSION_EVENT_KIND.ToolCall,
    SESSION_EVENT_KIND.ToolResult,
    SESSION_EVENT_KIND.Log,
    SESSION_EVENT_KIND.State,
    SESSION_EVENT_KIND.Artifact,
  ]) {
    expect(describeSessionEvent({ kind, payload: "{}" }).mono).toBe(false);
  }
});

test("a state transition renders from → to", () => {
  const d = describeSessionEvent({
    kind: SESSION_EVENT_KIND.State,
    payload: JSON.stringify({ from: "idle", to: "running" }),
  });
  expect(d.text).toBe("idle → running");
});

test("a malformed payload falls back to the raw string, never throws", () => {
  const d = describeSessionEvent({ kind: SESSION_EVENT_KIND.Message, payload: "not json" });
  expect(d.text).toBe("not json");
  expect(d.mono).toBe(false);
  // and an already-parsed object is accepted directly
  const obj = describeSessionEvent({
    kind: SESSION_EVENT_KIND.Log,
    payload: { line: "ok" },
  });
  expect(obj.text).toBe("ok");
});

// ── the feed drain/poll reducer ─────────────────────────────────────────────────

const ev = (over: Partial<Event> & Pick<Event, "idx" | "kind">): Event =>
  ({
    sessionUid: "s1",
    ts: "2026-07-08T00:00:00Z",
    fidelity: Fidelity.Exact,
    payload: "{}",
    ...over,
  }) as Event;

test("feedRowsFromEvents maps disponent kinds to string kinds and tracks maxIdx", () => {
  const { rows, maxIdx } = feedRowsFromEvents(
    [
      ev({ idx: 1, kind: EventKind.Message, payload: '{"role":"assistant","text":"hi"}' }),
      ev({ idx: 2, kind: EventKind.ToolCall, payload: '{"tool":"bash"}' }),
      ev({
        idx: 3,
        kind: EventKind.Raw,
        fidelity: Fidelity.Scraped,
        payload: '{"source":"terminal","data":"x"}',
      }),
    ],
    null,
  );
  expect(rows.map((r) => r.kind)).toEqual([
    SESSION_EVENT_KIND.Message,
    SESSION_EVENT_KIND.ToolCall,
    SESSION_EVENT_KIND.Raw,
  ]);
  expect(rows[2].fidelity).toBe("scraped");
  expect(maxIdx).toBe(3);
});

test("feedRowsFromEvents never re-emits events at or below the cursor (idempotent)", () => {
  const events = [
    ev({ idx: 5, kind: EventKind.Message }),
    ev({ idx: 6, kind: EventKind.Log }),
  ];
  const { rows, maxIdx } = feedRowsFromEvents(events, 5);
  expect(rows.map((r) => r.idx)).toEqual([6]);
  expect(maxIdx).toBe(6);
  // a cursor at or past the batch yields nothing
  expect(feedRowsFromEvents(events, 6).rows).toEqual([]);
});

test("FEED_KINDS carries every kind except Usage", () => {
  expect(FEED_KINDS).not.toContain(EventKind.Usage);
  expect(FEED_KINDS).toContain(EventKind.Message);
  expect(FEED_KINDS).toContain(EventKind.Raw);
});

// A tiny fake of the drizzle query builder surface pollDisponentFeed touches: a
// select→from→where read, an insert→values write, and an update→set→where write.
function fakeDeps(opts: {
  selectRows: Array<{ id: number; vmName: string | null; cursor: number | null }>;
  events: Event[];
}): {
  deps: PollDeps;
  inserted: Array<Record<string, unknown>>;
  updates: Array<Record<string, unknown>>;
} {
  const inserted: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    select: () => ({ from: () => ({ where: () => Promise.resolve(opts.selectRows) }) }),
    insert: () => ({
      values: (v: Record<string, unknown> | Array<Record<string, unknown>>) => {
        inserted.push(...(Array.isArray(v) ? v : [v]));
        return Promise.resolve();
      },
    }),
    update: () => ({
      set: (s: Record<string, unknown>) => ({
        where: () => {
          updates.push(s);
          return Promise.resolve();
        },
      }),
    }),
  } as unknown as PollDeps["db"];

  // A disponent whose events(...) streams the fabricated batch once, respecting afterIdx.
  const getDisponent = (() => {
    const d = {
      events: (o: { afterIdx?: number }) => {
        const batch = opts.events.filter((e) => o.afterIdx == null || e.idx > o.afterIdx);
        let i = 0;
        return { next: async () => (i < batch.length ? batch[i++] : null) };
      },
    };
    return () => d;
  })() as unknown as PollDeps["getDisponent"];

  const sessionForVm = (async () => ({
    uid: "dsession-uid",
  })) as unknown as PollDeps["sessionForVm"];

  return { deps: { db, getDisponent, sessionForVm }, inserted, updates };
}

test("pollDisponentFeed inserts feed rows and advances the cursor", async () => {
  const { deps, inserted, updates } = fakeDeps({
    selectRows: [{ id: 42, vmName: "vm-1", cursor: null }],
    events: [
      ev({ idx: 1, kind: EventKind.Message, payload: '{"role":"assistant","text":"hi"}' }),
      ev({ idx: 2, kind: EventKind.ToolCall, payload: '{"tool":"bash"}' }),
    ],
  });
  await pollDisponentFeed(deps);
  expect(inserted).toHaveLength(2);
  expect(inserted[0]).toMatchObject({ sessionId: 42, idx: 1, kind: SESSION_EVENT_KIND.Message });
  expect(inserted[1]).toMatchObject({ sessionId: 42, idx: 2, kind: SESSION_EVENT_KIND.ToolCall });
  expect(updates).toEqual([{ eventFeedCursor: 2 }]);
});

test("pollDisponentFeed drains only past the stored cursor (no duplicates)", async () => {
  const { deps, inserted, updates } = fakeDeps({
    selectRows: [{ id: 42, vmName: "vm-1", cursor: 5 }],
    events: [
      ev({ idx: 5, kind: EventKind.Message }), // already drained
      ev({ idx: 6, kind: EventKind.Log }),
    ],
  });
  await pollDisponentFeed(deps);
  expect(inserted.map((r) => r.idx)).toEqual([6]);
  expect(updates).toEqual([{ eventFeedCursor: 6 }]);
});

test("pollDisponentFeed no-ops with no live remote sessions", async () => {
  const { deps, inserted, updates } = fakeDeps({ selectRows: [], events: [] });
  await pollDisponentFeed(deps);
  expect(inserted).toHaveLength(0);
  expect(updates).toHaveLength(0);
});
