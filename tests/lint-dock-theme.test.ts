import { describe, expect, test } from "bun:test";
import { scanText } from "../scripts/lint-dock-theme.ts";

describe("scanText", () => {
  test("flags a dockview theme import", () => {
    const v = scanText('import { DockviewReact, themeAbyss } from "dockview-react";', "f.tsx");
    expect(v.map((d) => d.binding)).toEqual(["themeAbyss"]);
  });

  test("flags multiple theme bindings on one import line", () => {
    expect(
      scanText('import { themeNord, themeDracula } from "dockview-react";', "f.tsx").map(
        (d) => d.binding,
      ),
    ).toEqual(["themeNord", "themeDracula"]);
  });

  test("does NOT flag non-theme dockview imports", () => {
    expect(
      scanText('import { DockviewReact, type DockviewApi } from "dockview-react";', "f.tsx"),
    ).toEqual([]);
  });

  test("does NOT flag a theme* identifier imported from elsewhere", () => {
    expect(scanText('import { themeAbyss } from "./themes.ts";', "f.tsx")).toEqual([]);
  });

  test("respects a same-line lint-allow-dock-theme comment", () => {
    expect(
      scanText('import { themeAbyss } from "dockview-react"; // lint-allow-dock-theme: x', "f.tsx"),
    ).toEqual([]);
  });
});
