// Two appearance axes the user controls independently of the editor theme (and of
// each other): spacing density and font size. Theme = colors; density = how tight the
// layout is; font size = how big the text is. All three are orthogonal store settings.
//
// Density scales the spacing tokens (theme.ts builds theme.spacing from the base scale
// times the density factor) — and because spacing is emitted in px, it does NOT move
// when the font size changes. Font size scales the root font size, so every rem-based
// size (all Mantine `size=` text and controls) grows/shrinks together while spacing
// holds — that's what keeps the two axes independent.

export type Option = { key: string; label: string; factor: number };

// Base spacing scale in px (density factor 1.0 reproduces today's spacing exactly).
// Mantine's xs–xl keep their default px; hair/tight/snug/cozy are the compact tokens
// the dense UI actually needs, named so they read well in props.
export const BASE_SPACING: Record<string, number> = {
  hair: 2,
  tight: 4,
  snug: 6,
  cozy: 8,
  xs: 10,
  sm: 12,
  md: 16,
  lg: 20,
  xl: 32,
};

export const DENSITY: Option[] = [
  { key: "compact", label: "Compact", factor: 0.8 },
  { key: "default", label: "Default", factor: 1 },
  { key: "comfortable", label: "Comfortable", factor: 1.3 },
];

export const FONT_SCALE: Option[] = [
  { key: "sm", label: "Small", factor: 0.9 },
  { key: "md", label: "Default", factor: 1 },
  { key: "lg", label: "Large", factor: 1.15 },
];

export const DEFAULT_DENSITY = "default";
export const DEFAULT_FONT_SCALE = "md";

const find = (opts: Option[], key: string, fallback: string): Option =>
  opts.find((o) => o.key === key) ?? (opts.find((o) => o.key === fallback) as Option);

export const densityOption = (key: string): Option => find(DENSITY, key, DEFAULT_DENSITY);
export const fontScaleOption = (key: string): Option => find(FONT_SCALE, key, DEFAULT_FONT_SCALE);

/** Build the theme's spacing map (px strings) for a density factor. */
export function spacingFor(densityFactor: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, px] of Object.entries(BASE_SPACING)) {
    out[key] = `${Math.round(px * densityFactor)}px`;
  }
  return out;
}

/** Apply the font-size axis: set the root font size so every rem-based size scales.
 *  Spacing is px, so it's unaffected — the two axes stay independent. */
export function applyFontScale(key: string): void {
  document.documentElement.style.fontSize = `${16 * fontScaleOption(key).factor}px`;
}
