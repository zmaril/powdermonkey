import { describe, expect, test } from "bun:test";
import { scanText } from "../scripts/lint-emojis.ts";

// Lock in what counts as an emoji and what doesn't: pictographs and emoji-presentation
// glyphs are flagged; ordinary typography (arrows, dashes, ellipsis, middot, the
// geometric star) is not. Same-line allow comments suppress.
describe("scanText", () => {
  test("flags a pictographic emoji", () => {
    const v = scanText('const x = "💻";', "f.tsx");
    expect(v.map((d) => d.char)).toEqual(["💻"]);
    expect(v[0]).toMatchObject({ file: "f.tsx", line: 1 });
  });

  test("flags emoji in comments too", () => {
    expect(scanText("// launch it 💻 / ☁️", "f.tsx").map((d) => d.char)).toEqual(["💻", "☁"]);
  });

  test("flags emoji-presentation dingbats and arrows used as icons", () => {
    expect(scanText("Open ↗\n✅ done\n▶ play", "f.tsx").map((d) => d.char)).toEqual([
      "↗",
      "✅",
      "▶",
    ]);
  });

  test("does NOT flag ordinary typography or plain symbols", () => {
    // arrows (→ ← ↑ ↓), em/en dash, ellipsis, middot, geometric star and check mark
    // are Unicode symbols, not emoji — all allowed.
    expect(scanText("Goal → Milestone — note … · ★ ✓", "f.tsx")).toEqual([]);
  });

  test("does not report the bare variation selector / ZWJ on its own", () => {
    // The ☁️ is cloud + U+FE0F; we report the cloud once, not the selector separately.
    expect(scanText("☁️", "f.tsx").map((d) => d.char)).toEqual(["☁"]);
  });

  test("respects a same-line lint-allow-emoji comment", () => {
    expect(scanText('const x = "🤖"; // lint-allow-emoji: needed', "f.tsx")).toEqual([]);
  });
});
