import { describe, expect, test } from "bun:test";
import { scanText } from "../scripts/lint-svg.ts";

describe("scanText", () => {
  test("flags an inline JSX <svg>", () => {
    const v = scanText('return <svg width="13"><path d="…" /></svg>;', "f.tsx");
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ line: 1 });
  });

  test("flags createElement('svg')", () => {
    expect(scanText('createElement("svg", {})', "f.ts")).toHaveLength(1);
  });

  test("does NOT flag the word svg in prose or an import", () => {
    expect(
      scanText("// renders an svg icon\nimport { IconStar } from '@tabler/icons-react';", "f.tsx"),
    ).toEqual([]);
  });

  test("respects a same-line lint-allow-svg comment", () => {
    expect(scanText("<svg /> // lint-allow-svg: one-off", "f.tsx")).toEqual([]);
  });
});
