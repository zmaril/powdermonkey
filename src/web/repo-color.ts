import type { EditorTheme } from "./themes.ts";

// Repo identity color (see docs/vocabulary.md § Repo → Identity). Every repo gets a
// stable hue so cross-repo work is scannable at a glance. The hue is not stored as a
// color — a repo row carries only a *seed* (its slug by default, an operator override
// in `repos.color_seed`), and the seed is hashed into the ACTIVE theme's identity
// swatches here, at render time. That's what makes the color both stable (same seed →
// same swatch, forever) and theme-native (switch themes and every repo re-skins to the
// matching hue family instead of clashing with the new palette).
//
// Pure and DOM-free so the deterministic test suite can pin the mapping.

/** The seed a repo's color is derived from: the operator's explicit override when one
 *  is stored, else the slug — so a repo has a stable color from the moment it exists. */
export function repoColorSeed(repo: { colorSeed?: string | null; slug: string }): string {
  return repo.colorSeed?.trim() || repo.slug;
}

/** FNV-1a, 32-bit — a tiny, stable string hash. Not cryptographic; it only has to
 *  spread seeds evenly across a handful of swatches and never change between builds. */
export function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    // biome-ignore lint/suspicious/noBitwiseOperators: FNV-1a XOR step — the algorithm, not a typo.
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // biome-ignore lint/suspicious/noBitwiseOperators: coerce to an unsigned 32-bit int, per FNV-1a.
  return h >>> 0;
}

/** Resolve a repo's identity color in a theme: hash the seed into the theme's
 *  swatch list. Total — every theme ships a non-empty `swatches` array. */
export function repoSwatch(
  repo: { colorSeed?: string | null; slug: string },
  theme: EditorTheme,
): string {
  return theme.swatches[hashSeed(repoColorSeed(repo)) % theme.swatches.length];
}
