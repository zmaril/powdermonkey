import { describe, expect, test } from "bun:test";
import { scanText } from "../scripts/lint-boundaries.ts";

// The guard: files under src/nervo may import only within src/nervo plus the core's
// allowlisted deps (xstate); the example host is held to the same. scanText is pure —
// feed it synthetic files.

const CORE_DEPS = ["xstate"];

describe("nervo core (allowed root: src/nervo, deps: xstate)", () => {
  const scan = (text: string) =>
    scanText(text, "src/nervo/bus.ts", ["src/nervo"], CORE_DEPS, "nervo core");

  test("allows a sibling import within the core", () => {
    expect(scan('import { accepts } from "./fsm.ts";')).toEqual([]);
  });

  test("allows the allowlisted FSM dependency (xstate, and subpaths)", () => {
    expect(scan('import { createMachine } from "xstate";')).toEqual([]);
    expect(scan('import { x } from "xstate/guards";')).toEqual([]);
  });

  test("flags reaching into the plan schema (src/shared)", () => {
    const v = scan('import { TaskStatus } from "../shared/types.ts";');
    expect(v.map((d) => d.spec)).toEqual(["../shared/types.ts"]);
  });

  test("flags reaching into Immersion (src/web)", () => {
    expect(scan('import { useStore } from "../web/store.ts";').map((d) => d.spec)).toEqual([
      "../web/store.ts",
    ]);
  });

  test("flags a non-allowlisted package import", () => {
    expect(scan('import { create } from "zustand";').map((d) => d.spec)).toEqual(["zustand"]);
  });

  test("respects a same-line lint-allow-boundary comment", () => {
    expect(scan('import x from "../server/db.ts"; // lint-allow-boundary: reason')).toEqual([]);
  });
});

describe("example host (allowed root: src/nervo, deps: xstate)", () => {
  const scan = (text: string) =>
    scanText(text, "examples/word-host.ts", ["src/nervo"], CORE_DEPS, "example host");

  test("allows importing Nervo's public surface and xstate", () => {
    expect(scan('import { defineHost } from "../src/nervo/index.ts";')).toEqual([]);
    expect(scan('import { createMachine } from "xstate";')).toEqual([]);
  });

  test("flags a host reaching into PowderMonkey internals", () => {
    expect(
      scan('import { powdermonkey } from "../src/host/powdermonkey.ts";').map((d) => d.spec),
    ).toEqual(["../src/host/powdermonkey.ts"]);
  });
});
