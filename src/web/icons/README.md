# Custom icons

Icons in the UI come from [`@tabler/icons-react`](https://tabler.io/icons) — import
the named icon you need (`IconExternalLink`, `IconStar`, …) and render it.

This directory is the **only** place an inline `<svg>` is allowed. If a glyph genuinely
isn't in the set, draw it here as a small, named component — one custom icon per file,
matching the Tabler shape (a `size`-prop'd SVG that inherits `currentColor`) — and
import it like any other icon:

```tsx
// src/web/icons/IconPowderMonkey.tsx
export function IconPowderMonkey({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor">
      {/* … */}
    </svg>
  );
}
```

Enforced by `scripts/lint-svg.ts` (part of `bun run check`): `<svg>` anywhere outside
this directory fails the build. Keeping every icon a real, swappable component is what
lets the whole UI re-skin and stay consistent — the same reason we don't use emoji.
