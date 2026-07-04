import "@mantine/core/styles.css";
// Fira Code (variable) — the app's monospace face, loaded once so both the Mantine
// `fontFamilyMonospace` token (theme.ts) and the xterm terminals can use it.
import "@fontsource-variable/fira-code/index.css";
// Import dockview's stylesheet here, before theme.css, so our abyss-variable
// overrides in theme.css come last in the bundle and win. (App.tsx also imports
// it, but the module-graph position is fixed by this first occurrence.)
import "dockview-core/dist/styles/dockview.css";
import "./theme.css";
import "./motion.css";
import { MantineProvider } from "@mantine/core";
import { useLayoutEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.tsx";
import { applyFontScale, densityOption } from "./appearance.ts";
import { applyMotionVars } from "./motion.ts";
import { useStore } from "./store.ts";
import { buildTheme } from "./theme.ts";
import { applyThemeVars, getTheme } from "./themes.ts";
import { bootWindow } from "./window-bridge.ts";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

// Bind this webview to its PM window (from the `#w=<id>` hash, else adopt/mint) before
// the first render, so the dock restores the right window's layout on onReady. Each
// native window / browser tab is one PM window; the registry is shared, activeWindowId
// is this webview's alone. See docs/windows.md.
bootWindow();

// Wraps the app so the active code-editor theme (store state, persisted) drives the
// Mantine theme. Rebuilds the theme and re-applies the `--pm-*` document variables
// whenever the selection changes, so picking a theme in Settings re-skins the whole
// UI live — no reload. App reads the same selection for the dockview theme.
function ThemedRoot() {
  const themeKey = useStore((s) => s.theme);
  const density = useStore((s) => s.density);
  const fontScale = useStore((s) => s.fontScale);
  const motion = useStore((s) => s.motion);
  const editor = getTheme(themeKey);
  const densityFactor = densityOption(density).factor;
  const mantineTheme = useMemo(() => buildTheme(editor, densityFactor), [editor, densityFactor]);
  // Sync the CSS custom properties before paint so the dock/scrollbars/page never
  // flash the previous theme when the selection changes.
  useLayoutEffect(() => applyThemeVars(editor), [editor]);
  // Font-size axis: scale the root font so all rem-based text/controls grow together.
  // Spacing is px (density-scaled), so it stays put — the two controls are independent.
  useLayoutEffect(() => applyFontScale(fontScale), [fontScale]);
  // Motion axis: set the duration variables (and the off kill-switch attribute) that
  // motion.css reads, so every animation softens or stops from one control.
  useLayoutEffect(() => applyMotionVars(motion), [motion]);

  // Drive Mantine's own light/dark scheme from the theme, so light editor themes get
  // Mantine's real light defaults (white surfaces, dark text, proper Code / default
  // button contrast) instead of dark-scheme surfaces computed off a light palette.
  // No StrictMode: it double-invokes effects in dev, which churns the PTY WebSocket
  // (connect → cleanup → reconnect). The terminal owns a live socket, so a single,
  // stable mount is what we want.
  return (
    <MantineProvider forceColorScheme={editor.scheme} theme={mantineTheme}>
      <App />
    </MantineProvider>
  );
}

createRoot(root).render(<ThemedRoot />);
