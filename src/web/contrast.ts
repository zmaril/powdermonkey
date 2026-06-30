// WCAG relative-luminance + contrast-ratio math, shared by the theme contrast
// guardrail (tests/theme-contrast.test.ts) and any runtime check that wants it. Pure
// and dependency-free so it can run in the deterministic test suite.
//
// A theme that fails here renders text that can't be read against its own surface —
// the classic "white-on-white" failure (a light theme whose foreground was never
// lightened off the dark default). The test pins the token pairs the UI actually
// paints (body/dimmed/input text on their backgrounds, the terminal foreground on the
// terminal background) so a palette that drops contrast can't land.

/** Parse a #rgb / #rrggbb hex string to [r,g,b] (0–255). Throws on anything else so a
 *  malformed palette entry fails loudly rather than scoring as black. */
export function parseHex(hex: string): [number, number, number] {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) throw new Error(`not a #rgb/#rrggbb hex color: ${hex}`);
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return [
    Number.parseInt(h.slice(0, 2), 16),
    Number.parseInt(h.slice(2, 4), 16),
    Number.parseInt(h.slice(4, 6), 16),
  ];
}

/** WCAG relative luminance of a color channel (sRGB → linear). */
function channelLuminance(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance (0 = black, 1 = white) of a #hex color. */
export function luminance(hex: string): number {
  const [r, g, b] = parseHex(hex);
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

/** WCAG contrast ratio between two #hex colors (1 → identical, 21 → black-on-white). */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}
