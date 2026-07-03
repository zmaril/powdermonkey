import { Badge, Button, Card, type MantineTheme, Title, createTheme } from "@mantine/core";
import { spacingFor } from "./appearance.ts";
import type { EditorTheme } from "./themes.ts";

// Builds the Mantine theme for a given editor palette (see themes.ts). The palette
// supplies the surface scale (`dark`) and the signature accent (`accent`); this adds
// the type and component defaults that are the same regardless of palette. Called by
// main.tsx whenever the selected theme changes, so the whole Mantine layer re-skins.

const SANS =
  'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
export const MONO =
  '"Fira Code Variable", ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

export function buildTheme(t: EditorTheme, densityFactor: number): Partial<MantineTheme> {
  return createTheme({
    primaryColor: "accent",
    primaryShade: { light: t.primaryShade, dark: t.primaryShade },
    // Pick black/white button labels by the accent's luminance, so a filled/primary
    // button reads crisply in every theme instead of washing out.
    autoContrast: true,
    luminanceThreshold: 0.4,
    defaultRadius: "md",
    fontFamily: SANS,
    fontFamilyMonospace: MONO,
    // The spacing scale is part of the theme, and the user's density control scales it
    // (appearance.ts BASE_SPACING × densityFactor). PowderMonkey is a dense dashboard,
    // so its real workhorse spacings (2–8px) sit *below* Mantine's smallest default
    // token (xs = 10px) — which is why raw px crept in. We keep Mantine's xs–xl and add
    // a named compact sub-scale beneath them: hair / tight / snug / cozy. Components use
    // these tokens, never raw px (enforced by scripts/lint-spacing.ts) — that's what
    // lets the density control move all spacing at once. Emitted in px so the font-size
    // control (which scales rem) leaves spacing untouched: the two axes stay independent.
    spacing: spacingFor(densityFactor),
    headings: {
      fontFamily: SANS,
      fontWeight: "650",
    },
    colors: { accent: t.accent, dark: t.dark },
    components: {
      Card: Card.extend({
        defaultProps: { radius: "md", withBorder: true },
      }),
      Button: Button.extend({
        defaultProps: { radius: "md" },
        // A touch more weight so labels carry; pairs with the accent-tinted default
        // and subtle variants styled in theme.css.
        styles: { label: { fontWeight: 600 } },
      }),
      Badge: Badge.extend({
        defaultProps: { radius: "sm" },
        styles: { label: { fontWeight: 600 } },
      }),
      Title: Title.extend({
        styles: { root: { letterSpacing: "-0.01em" } },
      }),
    },
  });
}
