import { scan } from "react-scan";

// react-scan overlays every React re-render and flags the unnecessary ones (a
// commit that produced identical output). It's a dev diagnostic, never on in
// normal use, so it's gated behind an explicit opt-in: add `?scan` to the URL,
// or set localStorage["pm:react-scan"] = "1". Importing this module is cheap;
// nothing instruments React until the opt-in is present.
//
// This module is dev-only: it's imported solely by the main.scan.tsx entry,
// which `build:web:scan` builds. The production entry (main.tsx) never touches
// it, so react-scan stays out of the shipped bundle entirely.
//
// main.scan.tsx imports this BEFORE react-dom on purpose. react-scan instruments
// React's DevTools hook, and react-dom only registers its renderer with whatever
// hook exists at import time — install it late and the renderer never reports to
// us (renderers: 0, no onRender).
//
// When on, renders are outlined, logged to the console, and tallied per
// component on `window.__reactScan` so a headless run can read the report back
// out without scraping the overlay (see scripts/react-scan-report.ts).
//
// NOTE: react-scan can only instrument a *development* React build, which is the
// other thing build:web:scan does (NODE_ENV=development). Under the production
// `build:web` it would no-op anyway — but it isn't bundled there at all.

export interface ReactScanTally {
  /** commits React performed for this component */
  renders: number;
  /** of those, commits that changed nothing the user could see */
  unnecessary: number;
  /** total render time (ms) attributed to the component */
  time: number;
}

function scanEnabled(): boolean {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  return params.has("scan") || window.localStorage.getItem("pm:react-scan") === "1";
}

export function startReactScan(): void {
  if (!scanEnabled()) {
    // Keep the toolbar/overlay out of the normal UI entirely.
    scan({ enabled: false });
    return;
  }

  const tally = new Map<string, ReactScanTally>();
  (window as unknown as { __reactScan?: Map<string, ReactScanTally> }).__reactScan = tally;

  scan({
    enabled: true,
    log: true,
    onRender: (_fiber, renders) => {
      for (const render of renders) {
        const name = render.componentName ?? "(anonymous)";
        const row = tally.get(name) ?? { renders: 0, unnecessary: 0, time: 0 };
        row.renders += render.count;
        if (render.unnecessary) row.unnecessary += render.count;
        row.time += render.time ?? 0;
        tally.set(name, row);
      }
    },
  });

  console.info("[react-scan] enabled — re-renders are being tracked");
}

// Run at module-eval time (not via a deferred call) so the hook is in place
// before react-dom is imported. See the note above.
startReactScan();
