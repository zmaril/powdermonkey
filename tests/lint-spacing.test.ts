import { describe, expect, test } from "bun:test";
import { scanText } from "../scripts/lint-spacing.ts";

describe("scanText", () => {
  test("flags raw-px spacing props", () => {
    expect(scanText("<Group gap={6} py={8}>", "f.tsx").map((v) => `${v.prop}=${v.value}`)).toEqual([
      "gap=6",
      "py=8",
    ]);
  });

  test("allows {0} as an explicit none", () => {
    expect(scanText("<Stack gap={0}>", "f.tsx")).toEqual([]);
  });

  test("does NOT flag scale tokens", () => {
    expect(scanText('<Group gap="snug" px="md" mt="tight">', "f.tsx")).toEqual([]);
  });

  test("does NOT flag non-spacing numeric props", () => {
    expect(scanText("<Icon size={14} /> <Box w={18} maw={420} />", "f.tsx")).toEqual([]);
  });

  test("respects a same-line lint-allow-spacing comment", () => {
    expect(scanText("ml={26} // lint-allow-spacing: alignment offset", "f.tsx")).toEqual([]);
  });
});
