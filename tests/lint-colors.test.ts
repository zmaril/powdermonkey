import { describe, expect, test } from "bun:test";
import { scanText } from "../scripts/lint-colors.ts";

// Lock in what counts as a hardcoded color: hex literals (3/4/6/8 digits) are flagged
// wherever they appear; theme tokens (Mantine vars, --pm-* custom properties) are not;
// the same-line allow comment suppresses.
describe("scanText", () => {
  test("flags a 6-digit hex", () => {
    const v = scanText('color: "#1e1e1e"', "f.tsx");
    expect(v.map((d) => d.value)).toEqual(["#1e1e1e"]);
  });

  test("flags 3-digit and 8-digit hex", () => {
    expect(scanText("a #fff b #11223344 c", "f.tsx").map((d) => d.value)).toEqual([
      "#fff",
      "#11223344",
    ]);
  });

  test("does NOT flag theme tokens", () => {
    expect(
      scanText("color: var(--pm-text); background: var(--mantine-color-dark-6);", "f.tsx"),
    ).toEqual([]);
  });

  test("respects a same-line lint-allow-color comment", () => {
    const v = scanText('background: "#b54708", // lint-allow-color: fixed alert', "f.tsx");
    expect(v).toEqual([]);
  });

  test("ignores a non-color hash token (no hex run)", () => {
    // `#root` / `#section` are not hex colors.
    expect(scanText('querySelector("#root")', "f.tsx")).toEqual([]);
  });
});
