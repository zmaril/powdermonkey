import { describe, expect, test } from "bun:test";
import { scanText } from "../scripts/lint-fonts.ts";

describe("scanText", () => {
  test("flags an inline mono stack", () => {
    const v = scanText('fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"', "f.tsx");
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ line: 1 });
  });

  test("flags a CSS font-family declaration too", () => {
    expect(scanText(".x{font-family:Menlo,monospace;}", "f.css")).toHaveLength(1);
  });

  test("does NOT flag the Mantine font tokens or inherit", () => {
    expect(scanText('fontFamily: "var(--mantine-font-family-monospace)"', "f.tsx")).toEqual([]);
    expect(scanText("font-family:var(--mantine-font-family);", "f.css")).toEqual([]);
    expect(scanText('fontFamily: "inherit"', "f.tsx")).toEqual([]);
  });

  test("respects a same-line lint-allow-font comment", () => {
    expect(
      scanText(
        'fontFamily: "Menlo, monospace", // lint-allow-font: canvas needs a literal',
        "f.tsx",
      ),
    ).toEqual([]);
  });
});
