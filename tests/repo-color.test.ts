import { describe, expect, test } from "bun:test";
import { contrastRatio, parseHex } from "../src/web/contrast.ts";
import { hashSeed, repoColorSeed, repoSwatch } from "../src/web/repo-color.ts";
import { THEMES, THEME_ORDER } from "../src/web/themes.ts";

// The repo identity color contract (docs/vocabulary.md § Repo → Identity): a repo's
// color is derived from a stable seed, resolved into the ACTIVE theme's swatches. The
// mapping must be deterministic (it's re-derived on every render, in every client),
// override-able (repos.color_seed), and every theme must ship swatches that actually
// read against its own surfaces.

describe("repoColorSeed", () => {
  test("defaults to the slug", () => {
    expect(repoColorSeed({ colorSeed: null, slug: "zmaril/powdermonkey" })).toBe(
      "zmaril/powdermonkey",
    );
  });

  test("an operator override wins over the slug", () => {
    expect(repoColorSeed({ colorSeed: "crimson-crew", slug: "zmaril/powdermonkey" })).toBe(
      "crimson-crew",
    );
  });

  test("a blank override falls back to the slug", () => {
    expect(repoColorSeed({ colorSeed: "  ", slug: "o/n" })).toBe("o/n");
  });
});

describe("hashSeed", () => {
  test("is deterministic and unsigned", () => {
    expect(hashSeed("zmaril/powdermonkey")).toBe(hashSeed("zmaril/powdermonkey"));
    expect(hashSeed("zmaril/powdermonkey")).toBeGreaterThanOrEqual(0);
  });

  test("spreads nearby slugs across swatch indexes", () => {
    // Not a distribution proof — just pins that sibling repos under one owner don't
    // all collapse onto a single swatch (the failure mode a bad hash would produce).
    const slugs = ["o/api", "o/web", "o/cli", "o/docs", "o/infra", "o/ops"];
    const indexes = new Set(slugs.map((s) => hashSeed(s) % 7));
    expect(indexes.size).toBeGreaterThan(2);
  });
});

describe("repoSwatch", () => {
  const repo = { colorSeed: null, slug: "zmaril/powdermonkey" };

  test("resolves into the given theme's swatches, stably", () => {
    for (const key of THEME_ORDER) {
      const t = THEMES[key];
      const swatch = repoSwatch(repo, t);
      expect(t.swatches).toContain(swatch);
      expect(repoSwatch(repo, t)).toBe(swatch); // same seed, same theme → same swatch
    }
  });

  test("the same repo re-skins per theme but keeps its swatch index", () => {
    const index = hashSeed(repo.slug);
    for (const key of THEME_ORDER) {
      const t = THEMES[key];
      expect(repoSwatch(repo, t)).toBe(t.swatches[index % t.swatches.length]);
    }
  });
});

describe("theme swatches", () => {
  for (const key of THEME_ORDER) {
    const t = THEMES[key];
    describe(key, () => {
      test("ships a usable, distinct swatch set", () => {
        expect(t.swatches.length).toBeGreaterThanOrEqual(6);
        expect(new Set(t.swatches).size).toBe(t.swatches.length);
        for (const s of t.swatches) parseHex(s); // throws on a malformed entry
      });

      // Swatches paint identity accents (dots, borders, icon fallbacks) on the card
      // and pane surfaces — decorative, not body text, so the bar is visibility
      // (≥ 1.5:1), not WCAG text contrast.
      test("every swatch is visible on the card and pane surfaces", () => {
        for (const s of t.swatches) {
          expect(contrastRatio(s, t.dark[6])).toBeGreaterThanOrEqual(1.5);
          expect(contrastRatio(s, t.dark[7])).toBeGreaterThanOrEqual(1.5);
        }
      });
    });
  }
});
