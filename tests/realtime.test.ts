import { expect, test } from "bun:test";
import {
  addRealtimeClient,
  broadcast,
  notifyChange,
  realtimeClientCount,
  removeRealtimeClient,
} from "../src/server/realtime.ts";

// The realtime fan-out backs the WS change feed: register a client's send fn, get
// pinged on broadcast/notifyChange, and drop cleanly on close. Framework-free so it
// can be exercised without an Elysia socket.

test("broadcast reaches every registered client", () => {
  const a: string[] = [];
  const b: string[] = [];
  const keyA = {};
  const keyB = {};
  addRealtimeClient(keyA, (m) => a.push(m));
  addRealtimeClient(keyB, (m) => b.push(m));
  expect(realtimeClientCount()).toBe(2);

  broadcast("hello");
  expect(a).toEqual(["hello"]);
  expect(b).toEqual(["hello"]);

  removeRealtimeClient(keyA);
  removeRealtimeClient(keyB);
  expect(realtimeClientCount()).toBe(0);
});

test("a removed client stops receiving", () => {
  const got: string[] = [];
  const key = {};
  addRealtimeClient(key, (m) => got.push(m));
  removeRealtimeClient(key);
  broadcast("x");
  expect(got).toEqual([]);
});

test("a throwing client never breaks the fan-out", () => {
  const got: string[] = [];
  const bad = {};
  const good = {};
  addRealtimeClient(bad, () => {
    throw new Error("socket closing");
  });
  addRealtimeClient(good, (m) => got.push(m));
  expect(() => broadcast("y")).not.toThrow();
  expect(got).toEqual(["y"]);
  removeRealtimeClient(bad);
  removeRealtimeClient(good);
});

test("notifyChange coalesces a burst into one ping", async () => {
  const got: string[] = [];
  const key = {};
  addRealtimeClient(key, (m) => got.push(m));
  notifyChange();
  notifyChange();
  notifyChange();
  expect(got).toEqual([]); // nothing synchronous — coalesced to the next tick
  await Bun.sleep(60);
  expect(got).toEqual([JSON.stringify({ type: "changed" })]);
  removeRealtimeClient(key);
});
