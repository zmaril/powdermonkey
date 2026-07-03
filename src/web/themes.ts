// straitjacket-allow-file:color  the blessed palette source of truth — every editor palette's hex values live here by design
import type { MantineColorsTuple } from "@mantine/core";
import {
  themeAbyss,
  themeCatppuccinMocha,
  themeDark,
  themeDracula,
  themeGithubDark,
  themeGithubLight,
  themeLight,
  themeMonokai,
  themeNord,
  themeSolarizedLight,
  themeVisualStudio,
} from "dockview-react";

// The set of classic code-editor themes the app can wear — every theme dockview
// ships (the "-spaced" layout variants are the same colors with padding, left out so
// the picker stays one-card-per-look). Each entry bundles two halves so the whole UI
// stays in one identity when you switch:
//
//   • `dockTheme` — the real dockview theme object, passed to <DockviewReact theme>.
//     The dock chrome is then dockview's own, native rendering of that theme.
//   • the palette roles (`dark`, `accent`, …) — fed into the Mantine theme (theme.ts)
//     and onto the document as `--pm-*` custom properties (applyThemeVars), so the
//     pane *contents* (cards, text, badges, scrollbars, selection, the terminal)
//     match the dock instead of clashing with it.
//
// Light themes need no Mantine color-scheme switch: the `dark` tuple is laid out the
// same way (index 0 = primary text, 7 = page background), so a light theme is just
// that tuple inverted in luminance — dark text on a light page. applyThemeVars sets
// document.colorScheme so native controls/scrollbars follow.
//
// Hex values come from each theme's published palette (dockview's own, for the dark
// greys; the canonical editor palettes otherwise) — not hand-tuning.

export type EditorTheme = {
  key: string;
  label: string;
  scheme: "dark" | "light";
  // The dockview theme object for the dock chrome.
  dockTheme: typeof themeAbyss;
  // Surface scale, primary text (0) → page background (9). Mantine reads its standard
  // roles off it: text = dark[0], dimmed = dark[2], borders = dark[4], card = dark[6],
  // page = dark[7]. For light themes the same indices hold (dark text, light page).
  dark: MantineColorsTuple;
  // Accent ramp (the theme's signature color), light → dark. Saturated enough that the
  // primary buttons pop.
  accent: MantineColorsTuple;
  // Index into `accent` used as the primary (buttons, switches, active-tab rule).
  primaryShade: number;
  // xterm terminal background — matched to the theme so the shell is seamless.
  terminalBg: string;
  // ::selection highlight (accent at low alpha).
  selection: string;
  // Repo identity swatches — the theme's canonical accent hues (its syntax/ANSI
  // palette), one of which each repo is assigned by hashing its color seed (see
  // repo-color.ts). Living here means a repo's color always belongs to the active
  // theme: switch themes and every repo re-skins to the matching hue family.
  swatches: string[];
};

export const THEMES: Record<string, EditorTheme> = {
  // One Dark (Atom / VS Code) — also the embedded CodeMirror editor's theme. dockview
  // has no native One Dark, so it rides Abyss and we re-skin Abyss to these colors
  // (theme.css, scoped to the .pm-skin-onedark wrapper so native Abyss is unaffected).
  "one-dark": {
    key: "one-dark",
    label: "One Dark",
    scheme: "dark",
    dockTheme: themeAbyss,
    dark: [
      "#abb2bf",
      "#9da5b4",
      "#828a98",
      "#5c6370",
      "#3b4048",
      "#2f343d",
      "#2c313a",
      "#21252b",
      "#1b1e24",
      "#16181d",
    ],
    accent: [
      "#eaf4fd",
      "#d2e7fa",
      "#a6cef4",
      "#7bb6ef",
      "#61afef",
      "#4f9fe0",
      "#3f8ccb",
      "#3576ad",
      "#2d6390",
      "#244e72",
    ],
    primaryShade: 4,
    terminalBg: "#21252b",
    selection: "rgba(97, 175, 239, 0.3)",
    // One Dark's syntax palette: red, orange, yellow, green, cyan, blue, magenta.
    swatches: ["#e06c75", "#d19a66", "#e5c07b", "#98c379", "#56b6c2", "#61afef", "#c678dd"],
  },

  // VS Code Dark — dockview's "dark" theme. Neutral grey, vivid blue accent.
  dark: {
    key: "dark",
    label: "VS Code Dark",
    scheme: "dark",
    dockTheme: themeDark,
    dark: [
      "#d4d4d4",
      "#bdbdbd",
      "#969696",
      "#6b6b6b",
      "#3c3c3c",
      "#2d2d2d",
      "#252526",
      "#1e1e1e",
      "#181818",
      "#121212",
    ],
    accent: [
      "#e1f3ff",
      "#b8e2ff",
      "#82cbff",
      "#48b0f5",
      "#1f97e6",
      "#0d86d8",
      "#007acc",
      "#0768ad",
      "#0a568b",
      "#0a456e",
    ],
    primaryShade: 5,
    terminalBg: "#1e1e1e",
    selection: "rgba(0, 122, 204, 0.3)",
    // VS Code Dark's bright ANSI terminal hues + the string/keyword token colors.
    swatches: ["#f14c4c", "#ce9178", "#dcdcaa", "#23d18b", "#29b8db", "#3b8eea", "#d670d6"],
  },

  // Visual Studio — dockview's "vs". Like Dark but with a brighter focus-blue accent.
  vs: {
    key: "vs",
    label: "Visual Studio",
    scheme: "dark",
    dockTheme: themeVisualStudio,
    dark: [
      "#d4d4d4",
      "#bdbdbd",
      "#969696",
      "#6b6b6b",
      "#3f3f46",
      "#2d2d30",
      "#252526",
      "#1e1e1e",
      "#181818",
      "#121212",
    ],
    accent: [
      "#e8f2ff",
      "#c5dfff",
      "#93c2ff",
      "#5fa2ff",
      "#3a8aff",
      "#1f8fff",
      "#0e7fef",
      "#0a6cce",
      "#0a57a4",
      "#0b477f",
    ],
    primaryShade: 5,
    terminalBg: "#1e1e1e",
    selection: "rgba(55, 148, 255, 0.3)",
    // Same editor family as VS Code Dark — the same bright ANSI/token hues.
    swatches: ["#f14c4c", "#ce9178", "#dcdcaa", "#23d18b", "#29b8db", "#3b8eea", "#d670d6"],
  },

  // Abyss — dockview's native deep-navy theme, electric-purple accent.
  abyss: {
    key: "abyss",
    label: "Abyss",
    scheme: "dark",
    dockTheme: themeAbyss,
    dark: [
      "#d4d7e0",
      "#b3b7c9",
      "#9497a9",
      "#5e6178",
      "#2b2b4a",
      "#1f2540",
      "#1c1c2a",
      "#10192c",
      "#08101f",
      "#000c18",
    ],
    accent: [
      "#ece8fb",
      "#d4cbf7",
      "#b3a1f0",
      "#9377e9",
      "#7b54e4",
      "#6a3ae3",
      "#5f2ddf",
      "#5b1ecf",
      "#4a18ab",
      "#3a1387",
    ],
    primaryShade: 5,
    terminalBg: "#10192c",
    selection: "rgba(106, 58, 227, 0.35)",
    // Abyss's token palette: pink, sand, cream, green, blues, violet.
    swatches: ["#f280d0", "#ddbb88", "#ffeebb", "#22aa44", "#2277ff", "#6688cc", "#9966b8"],
  },

  // Dracula — the iconic dark-purple theme.
  dracula: {
    key: "dracula",
    label: "Dracula",
    scheme: "dark",
    dockTheme: themeDracula,
    dark: [
      "#f8f8f2",
      "#e2e2dc",
      "#8b90b3",
      "#6272a4",
      "#44475a",
      "#3a3d4d",
      "#343746",
      "#282a36",
      "#21222c",
      "#1b1c24",
    ],
    accent: [
      "#f5eeff",
      "#e6d6ff",
      "#d3b6fc",
      "#c6a0fa",
      "#bd93f9",
      "#a87fe6",
      "#9269c9",
      "#7c57ad",
      "#684793",
      "#543676",
    ],
    primaryShade: 4,
    terminalBg: "#282a36",
    selection: "rgba(189, 147, 249, 0.32)",
    // Dracula's published accent set: red, orange, yellow, green, cyan, purple, pink.
    swatches: ["#ff5555", "#ffb86c", "#f1fa8c", "#50fa7b", "#8be9fd", "#bd93f9", "#ff79c6"],
  },

  // Monokai — warm dark; dockview's native accent is the signature lime green.
  monokai: {
    key: "monokai",
    label: "Monokai",
    scheme: "dark",
    dockTheme: themeMonokai,
    dark: [
      "#f8f8f2",
      "#e6e6dc",
      "#a59f88",
      "#75715e",
      "#49483e",
      "#3e3d32",
      "#34352c",
      "#272822",
      "#22231d",
      "#1c1d17",
    ],
    accent: [
      "#f2fcd9",
      "#e3f8a8",
      "#cdef6f",
      "#b6e63f",
      "#a6e22e",
      "#8fc524",
      "#76a31c",
      "#5f8417",
      "#4c6912",
      "#3a500d",
    ],
    primaryShade: 4,
    terminalBg: "#272822",
    selection: "rgba(166, 226, 46, 0.22)",
    // Monokai's syntax palette: pink, orange, yellow, green, cyan, purple, magenta.
    swatches: ["#f92672", "#fd971f", "#e6db74", "#a6e22e", "#66d9ef", "#ae81ff", "#fd5ff0"],
  },

  // Nord — arctic blue-greys. A punchier frost-blue accent so buttons aren't washed out.
  nord: {
    key: "nord",
    label: "Nord",
    scheme: "dark",
    dockTheme: themeNord,
    dark: [
      "#eceff4",
      "#d8dee9",
      "#8a93a5",
      "#4c566a",
      "#434c5e",
      "#454d5e",
      "#3b4252",
      "#2e3440",
      "#2a2f3a",
      "#252a33",
    ],
    accent: [
      "#eaf2fb",
      "#d2e1f1",
      "#aac4e0",
      "#82a7cf",
      "#6790c4",
      "#5681bb",
      "#5379ad",
      "#4a6c9b",
      "#3f5c84",
      "#344c6e",
    ],
    primaryShade: 5,
    terminalBg: "#2e3440",
    selection: "rgba(129, 161, 193, 0.3)",
    // Nord's aurora (red→purple) + frost (teals/blues) accents.
    swatches: [
      "#bf616a",
      "#d08770",
      "#ebcb8b",
      "#a3be8c",
      "#b48ead",
      "#8fbcbb",
      "#88c0d0",
      "#81a1c1",
    ],
  },

  // GitHub Dark — near-black neutral, vivid blue accent.
  "github-dark": {
    key: "github-dark",
    label: "GitHub Dark",
    scheme: "dark",
    dockTheme: themeGithubDark,
    dark: [
      "#c9d1d9",
      "#adbac7",
      "#8b949e",
      "#6e7681",
      "#30363d",
      "#21262d",
      "#161b22",
      "#0d1117",
      "#0a0d12",
      "#06080c",
    ],
    accent: [
      "#e8f1ff",
      "#cce3ff",
      "#a3caff",
      "#79b1ff",
      "#58a6ff",
      "#3f93f5",
      "#2986e6",
      "#1f6fc4",
      "#1d5ba0",
      "#1b497e",
    ],
    primaryShade: 5,
    terminalBg: "#0d1117",
    selection: "rgba(56, 166, 255, 0.3)",
    // GitHub Primer's dark accent scale: red, orange, yellow, green, cyan, blue, purple, pink.
    swatches: [
      "#ff7b72",
      "#ffa657",
      "#e3b341",
      "#3fb950",
      "#39c5cf",
      "#58a6ff",
      "#bc8cff",
      "#f778ba",
    ],
  },

  // Catppuccin Mocha — soft pastel on a deep indigo base, blue accent.
  "catppuccin-mocha": {
    key: "catppuccin-mocha",
    label: "Catppuccin Mocha",
    scheme: "dark",
    dockTheme: themeCatppuccinMocha,
    dark: [
      "#cdd6f4",
      "#bac2de",
      "#a6adc8",
      "#6c7086",
      "#45475a",
      "#3a3c51",
      "#313244",
      "#1e1e2e",
      "#181825",
      "#11111b",
    ],
    accent: [
      "#eef4ff",
      "#d9e7fe",
      "#b8d0fc",
      "#97b9fb",
      "#89b4fa",
      "#7099df",
      "#5d80bc",
      "#4d699a",
      "#40567d",
      "#334564",
    ],
    primaryShade: 4,
    terminalBg: "#1e1e2e",
    selection: "rgba(137, 180, 250, 0.26)",
    // Catppuccin Mocha's pastels: red, peach, yellow, green, teal, blue, mauve, pink.
    swatches: [
      "#f38ba8",
      "#fab387",
      "#f9e2af",
      "#a6e3a1",
      "#94e2d5",
      "#89b4fa",
      "#cba6f7",
      "#f5c2e7",
    ],
  },

  // ── Light themes (dark tuple laid out for a light page) ──────────────────────

  // VS Code Light — dockview's "light".
  light: {
    key: "light",
    label: "VS Code Light",
    scheme: "light",
    dockTheme: themeLight,
    dark: [
      "#1f1f1f",
      "#3a3a3a",
      "#6a6a6a",
      "#8a8a8a",
      "#d0d0d0",
      "#e8e8e8",
      "#ffffff",
      "#f3f3f3",
      "#ececec",
      "#e4e4e4",
    ],
    accent: [
      "#e7f0ff",
      "#c4dbff",
      "#93bcff",
      "#5e98ff",
      "#3a7eff",
      "#1f6bf0",
      "#0a6cdb",
      "#0a5ab8",
      "#0c4c97",
      "#0d3f7b",
    ],
    primaryShade: 6,
    terminalBg: "#ffffff",
    selection: "rgba(10, 108, 219, 0.18)",
    // VS Code Light's token/ANSI hues — dark enough to read on the white page.
    swatches: ["#cd3131", "#795e26", "#098658", "#267f99", "#0451a5", "#af00db", "#811f3f"],
  },

  // GitHub Light.
  "github-light": {
    key: "github-light",
    label: "GitHub Light",
    scheme: "light",
    dockTheme: themeGithubLight,
    dark: [
      "#1f2328",
      "#373e47",
      "#656d76",
      "#8c959f",
      "#d0d7de",
      "#e6eaef",
      "#ffffff",
      "#f6f8fa",
      "#eaeef2",
      "#e2e7eb",
    ],
    accent: [
      "#ddf4ff",
      "#b6e3ff",
      "#80ccff",
      "#54aeff",
      "#218bff",
      "#0969da",
      "#0860c9",
      "#0a53b0",
      "#0a468f",
      "#0a3a73",
    ],
    primaryShade: 5,
    terminalBg: "#ffffff",
    selection: "rgba(9, 105, 218, 0.15)",
    // GitHub Primer's light accent scale: red, orange, yellow, green, cyan, blue, purple, pink.
    swatches: [
      "#cf222e",
      "#bc4c00",
      "#9a6700",
      "#1a7f37",
      "#1b7c83",
      "#0969da",
      "#8250df",
      "#bf3989",
    ],
  },

  // Solarized Light.
  "solarized-light": {
    key: "solarized-light",
    label: "Solarized Light",
    scheme: "light",
    dockTheme: themeSolarizedLight,
    // Solarized's published content tones (base01 #586e75 / base00 #657b83) are famously
    // low-contrast and only reach ~4:1 on the cream surfaces — text fails AA and dimmed
    // is well under it. Pull the text roles down to the darker base tones (base02/base01)
    // so body and dimmed text clear contrast on every Solarized surface; the lighter
    // surface indices (4–9) keep the canonical cream palette.
    dark: [
      "#073642",
      "#2a5560",
      "#586e75",
      "#93a1a1",
      "#d6cfb8",
      "#e6dfc8",
      "#fdf6e3",
      "#eee8d5",
      "#e6dfca",
      "#ddd6bf",
    ],
    accent: [
      "#e3f1fb",
      "#c3e0f4",
      "#8fc4ea",
      "#56a5dd",
      "#3093d6",
      "#268bd2",
      "#2179b7",
      "#1d6499",
      "#19527d",
      "#154363",
    ],
    primaryShade: 5,
    terminalBg: "#fdf6e3",
    selection: "rgba(38, 139, 210, 0.18)",
    // Solarized's eight published accents: yellow, orange, red, magenta, violet, blue, cyan, green.
    swatches: [
      "#b58900",
      "#cb4b16",
      "#dc322f",
      "#d33682",
      "#6c71c4",
      "#268bd2",
      "#2aa198",
      "#859900",
    ],
  },
};

// Order shown in the Settings picker — dark themes first, then light.
export const THEME_ORDER = [
  "one-dark",
  "dark",
  "vs",
  "abyss",
  "dracula",
  "monokai",
  "nord",
  "github-dark",
  "catppuccin-mocha",
  "light",
  "github-light",
  "solarized-light",
];

export const DEFAULT_THEME = "one-dark";

export function getTheme(key: string): EditorTheme {
  return THEMES[key] ?? THEMES[DEFAULT_THEME];
}

// Push a theme's surface/accent roles onto the document as `--pm-*` custom
// properties. theme.css maps its own rules — and (for One Dark) the Abyss `--dv-*`
// variables — to these, so the page background, scrollbars, text selection and
// button hovers re-skin to match the Mantine theme. Native dockview themes paint
// their own chrome; the `--pm-*` vars still align everything around them.
export function applyThemeVars(t: EditorTheme): void {
  const s = document.documentElement.style;
  s.setProperty("--pm-page-bg", t.dark[8]);
  s.setProperty("--pm-pane-bg", t.dark[7]);
  s.setProperty("--pm-surface", t.dark[6]);
  s.setProperty("--pm-tab-strip", t.dark[7]);
  s.setProperty("--pm-hairline", t.dark[4]);
  s.setProperty("--pm-accent", t.accent[t.primaryShade]);
  s.setProperty("--pm-text", t.dark[0]);
  s.setProperty("--pm-dim-text", t.dark[2]);
  s.setProperty("--pm-scroll-thumb", t.dark[4]);
  s.setProperty("--pm-scroll-thumb-hover", t.dark[3]);
  s.setProperty("--pm-card-hover-border", t.dark[3]);
  s.setProperty("--pm-selection", t.selection);
  // Light themes get a light color-scheme so native scrollbars/inputs match.
  s.setProperty("color-scheme", t.scheme);
  document.body.style.backgroundColor = t.dark[8];
}
