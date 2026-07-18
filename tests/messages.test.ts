import { expect, test } from "bun:test";
import { ackProgress, messageDto } from "../src/shared/messages.ts";

// The manager↔worker Message wire shape the /messages route returns, plus the pure
// ack-progress reducer behind the fan-out "N of M acked" indicator. Both are dependency-
// free, so they're pinned here without opening the native disponent engine.

// ── messageDto ──────────────────────────────────────────────────────────────────

test("messageDto projects a disponent Message onto the wire DTO", () => {
  const dto = messageDto({
    id: "m-1",
    sender: "worker",
    recipient: "manager",
    body: "Should I bump the shared dep to v3?",
    fanoutId: "f-1",
    topic: "dep-bump",
    ackedAt: "2026-07-18T00:00:00.000Z",
  });
  // `id` surfaces as `messageId` so it lines up with the mail event's MailRef.messageId
  expect(dto.messageId).toBe("m-1");
  expect(dto.sender).toBe("worker");
  expect(dto.recipient).toBe("manager");
  expect(dto.body).toBe("Should I bump the shared dep to v3?");
  expect(dto.fanoutId).toBe("f-1");
  expect(dto.topic).toBe("dep-bump");
  expect(dto.ackedAt).toBe("2026-07-18T00:00:00.000Z");
});

test("messageDto normalizes an absent topic/ackedAt to null (stable wire shape)", () => {
  const dto = messageDto({
    id: "m-2",
    sender: "manager",
    recipient: "worker",
    body: "hi",
    fanoutId: "f-2",
  });
  expect(dto.topic).toBeNull();
  expect(dto.ackedAt).toBeNull();
});

// ── ackProgress ─────────────────────────────────────────────────────────────────

test("ackProgress counts acked over total across a fan-out", () => {
  const rows = [
    { ackedAt: "2026-07-18T00:00:00Z" },
    { ackedAt: null },
    { ackedAt: "2026-07-18T00:01:00Z" },
    { ackedAt: null },
    { ackedAt: "2026-07-18T00:02:00Z" },
  ];
  expect(ackProgress(rows)).toEqual({ acked: 3, total: 5 });
});

test("ackProgress on an empty read is 0 of 0 (nothing to show)", () => {
  expect(ackProgress([])).toEqual({ acked: 0, total: 0 });
});

test("ackProgress with none acked is 0 of N", () => {
  expect(ackProgress([{ ackedAt: null }, { ackedAt: null }])).toEqual({ acked: 0, total: 2 });
});
