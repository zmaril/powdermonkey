import { describe, expect, test } from "bun:test";
import { contrastRatio } from "../src/web/contrast.ts";
import { THEMES, THEME_ORDER } from "../src/web/themes.ts";

// Guardrail: no theme may ship text that can't be read against its own surfaces. This
// is what caught GitHub Light rendering the terminal white-on-white (the foreground was
// never derived off a token, so xterm's default white sat on a white background) and
// Solarized Light's body/dimmed text dropping under AA on its cream page.
//
// We pin the token pairs the UI actually paints (themes.ts#applyThemeVars maps these):
//   • text    = dark[0]  — body text, and the terminal foreground (ShellTerminal)
//   • dimmed  = dark[2]  — secondary / "c=dimmed" text
//   • surfaces: page = dark[8], pane = dark[7], card = dark[6], terminal = terminalBg
//
// Thresholds follow WCAG 2.1: 4.5:1 for body-weight text, 3.0:1 for the deliberately
// de-emphasised dimmed text (it never carries primary content). A palette that fails
// here is unreadable somewhere, so the test fails and it can't land.
const BODY_MIN = 4.5;
const DIMMED_MIN = 3.0;

describe("theme contrast", () => {
  // Cover every theme, and make sure THEME_ORDER and THEMES stay in lockstep so a newly
  // added theme is actually exercised here rather than silently skipped.
  test("THEME_ORDER lists exactly the defined themes", () => {
    expect([...THEME_ORDER].sort()).toEqual(Object.keys(THEMES).sort());
  });

  for (const key of THEME_ORDER) {
    const t = THEMES[key];
    const text = t.dark[0];
    const dimmed = t.dark[2];
    const surfaces = {
      page: t.dark[8],
      pane: t.dark[7],
      card: t.dark[6],
      terminal: t.terminalBg,
    };

    describe(key, () => {
      for (const [name, bg] of Object.entries(surfaces)) {
        test(`body text on ${name} ≥ ${BODY_MIN}:1`, () => {
          expect(contrastRatio(text, bg)).toBeGreaterThanOrEqual(BODY_MIN);
        });
      }
      // Dimmed text is only painted on the content surfaces, not the terminal.
      for (const name of ["page", "pane", "card"] as const) {
        test(`dimmed text on ${name} ≥ ${DIMMED_MIN}:1`, () => {
          expect(contrastRatio(dimmed, surfaces[name])).toBeGreaterThanOrEqual(DIMMED_MIN);
        });
      }
    });
  }
});
