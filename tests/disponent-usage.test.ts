import { expect, test } from "bun:test";
import { type Event, EventKind } from "@disponent/node";
import { accumulateUsage } from "../src/server/disponent-usage.ts";

// The pure reducer behind the per-backend usage meters: it folds a batch of
// disponent events onto prior totals. These pin its contract without any live
// backend — Usage events accumulate tokens + fractional cents, everything else is
// ignored, string costs are summed as numbers, and the max idx advances so the
// caller's cursor moves past drained events.

const ev = (over: Partial<Event> & Pick<Event, "idx" | "kind">): Event =>
  ({
    sessionUid: "s1",
    ts: "2026-07-08T00:00:00Z",
    fidelity: 0,
    payload: "{}",
    ...over,
  }) as Event;

const usage = (idx: number, payload: object): Event =>
  ev({ idx, kind: EventKind.Usage, payload: JSON.stringify(payload) });

const zero = { inputTokens: 0, outputTokens: 0, costCents: 0 };

test("empty batch leaves prior totals unchanged and reports no idx", () => {
  expect(accumulateUsage(zero, [])).toEqual({ ...zero, maxIdx: null });
  const prior = { inputTokens: 5, outputTokens: 7, costCents: 3.5 };
  expect(accumulateUsage(prior, [])).toEqual({ ...prior, maxIdx: null });
});

test("Usage events accumulate tokens and cost onto prior totals", () => {
  const out = accumulateUsage(zero, [
    usage(1, { inputTokens: 100, outputTokens: 20, costCents: "1.5" }),
    usage(2, { inputTokens: 50, outputTokens: 10, costCents: "0.75" }),
  ]);
  expect(out.inputTokens).toBe(150);
  expect(out.outputTokens).toBe(30);
  expect(out.costCents).toBeCloseTo(2.25, 6);
  expect(out.maxIdx).toBe(2);
});

test("string costCents are summed as numbers, not concatenated", () => {
  const out = accumulateUsage(zero, [
    usage(1, { costCents: "10" }),
    usage(2, { costCents: "5" }),
  ]);
  expect(out.costCents).toBe(15);
});

test("missing token/cost fields default to zero", () => {
  const out = accumulateUsage(zero, [usage(3, {})]);
  expect(out).toEqual({ inputTokens: 0, outputTokens: 0, costCents: 0, maxIdx: 3 });
});

test("non-Usage events are ignored for totals but still advance maxIdx", () => {
  const out = accumulateUsage(zero, [
    usage(1, { inputTokens: 10, outputTokens: 2, costCents: "1" }),
    ev({ idx: 5, kind: EventKind.Message, payload: '{"text":"hi"}' }),
    ev({ idx: 3, kind: EventKind.ToolCall, payload: "{}" }),
  ]);
  expect(out.inputTokens).toBe(10);
  expect(out.outputTokens).toBe(2);
  expect(out.costCents).toBe(1);
  expect(out.maxIdx).toBe(5); // the cursor advances past drained non-Usage events too
});

test("a malformed payload is skipped, never thrown", () => {
  const out = accumulateUsage(zero, [
    ev({ idx: 1, kind: EventKind.Usage, payload: "not json" }),
    usage(2, { inputTokens: 4, costCents: "2" }),
  ]);
  expect(out.inputTokens).toBe(4);
  expect(out.costCents).toBe(2);
  expect(out.maxIdx).toBe(2);
});
