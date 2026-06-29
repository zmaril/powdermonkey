import { describe, expect, test } from "bun:test";
import { scanText } from "../scripts/lint-motion.ts";

describe("scanText", () => {
  test("flags a CSS transition", () => {
    expect(scanText(".x{transition: color 120ms ease;}", "f.css").map((v) => v.match)).toEqual([
      "transition",
    ]);
  });

  test("flags transition longhand, animation, and @keyframes", () => {
    expect(
      scanText("transition-duration: 1s; animation: pulse 1s; @keyframes pulse {}", "f.tsx").map(
        (v) => v.match,
      ),
    ).toEqual(["transition-duration", "animation", "@keyframes"]);
  });

  test("flags an inline style transition in TSX", () => {
    expect(scanText('style={{ transition: "transform 120ms ease" }}', "f.tsx")).toHaveLength(1);
  });

  test("does NOT flag transitionProps, transitionState, or the word in prose", () => {
    expect(scanText("transitionProps={{ duration: 100 }}", "f.tsx")).toEqual([]);
    expect(
      scanText("const s: StateTransition = x; // a needs-you transition fires", "f.tsx"),
    ).toEqual([]);
  });

  test("respects a same-line lint-allow-motion comment", () => {
    expect(scanText('transition: "all 1s", // lint-allow-motion: one-off', "f.tsx")).toEqual([]);
  });
});
