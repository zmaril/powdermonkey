import { describe, expect, test } from "bun:test";
import { scanText } from "../scripts/lint-boundaries.ts";

// The guard: files under src/nervo may only import within src/nervo; the example host
// may only import from src/nervo. scanText is pure — feed it synthetic files.

describe("nervo core (allowed root: src/nervo)", () => {
  const allowed = ["src/nervo"];
  const scan = (text: string) => scanText(text, "src/nervo/bus.ts", allowed, "nervo core");

  test("allows a sibling import within the core", () => {
    expect(scan('import { canTransition } from "./fsm.ts";')).toEqual([]);
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

  test("flags a bare package import (the core is dependency-free)", () => {
    expect(scan('import { create } from "zustand";').map((d) => d.spec)).toEqual(["zustand"]);
  });

  test("respects a same-line lint-allow-boundary comment", () => {
    expect(scan('import x from "../server/db.ts"; // lint-allow-boundary: reason')).toEqual([]);
  });
});

describe("example host (allowed root: src/nervo)", () => {
  const scan = (text: string) =>
    scanText(text, "examples/word-host.ts", ["src/nervo"], "example host");

  test("allows importing Nervo's public surface", () => {
    expect(scan('import { defineHost } from "../src/nervo/index.ts";')).toEqual([]);
  });

  test("flags a host reaching into PowderMonkey internals", () => {
    expect(
      scan('import { powdermonkey } from "../src/host/powdermonkey.ts";').map((d) => d.spec),
    ).toEqual(["../src/host/powdermonkey.ts"]);
  });
});
