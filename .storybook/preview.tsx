// Global Storybook setup: wrap every story in the same MantineProvider main.tsx uses,
// load the same stylesheets, and expose a theme picker in the toolbar so any pane can
// be eyeballed in every editor palette. Kept deliberately parallel to main.tsx so what
// you see in a story matches what the app renders.
import "@mantine/core/styles.css";
import "@fontsource-variable/fira-code/index.css";
import "dockview-core/dist/styles/dockview.css";
import "../src/web/theme.css";
import "../src/web/motion.css";
import { MantineProvider } from "@mantine/core";
import type { Decorator, Preview } from "@storybook/react-vite";
import { useLayoutEffect } from "react";
import { buildTheme } from "../src/web/theme.ts";
import { applyThemeVars, DEFAULT_THEME, getTheme, THEME_ORDER, THEMES } from "../src/web/themes.ts";

const withTheme: Decorator = (Story, context) => {
  const editor = getTheme(context.globals.theme ?? DEFAULT_THEME);
  // Re-apply the `--pm-*` document variables (page/pane background, scrollbars, …) the
  // way ThemedRoot does, so the story surface matches the pane, not Storybook's canvas.
  useLayoutEffect(() => applyThemeVars(editor), [editor]);
  return (
    <MantineProvider forceColorScheme={editor.scheme} theme={buildTheme(editor, 1)}>
      <Story />
    </MantineProvider>
  );
};

const preview: Preview = {
  decorators: [withTheme],
  globalTypes: {
    theme: {
      description: "Editor palette",
      defaultValue: DEFAULT_THEME,
      toolbar: {
        title: "Theme",
        icon: "paintbrush",
        dynamicTitle: true,
        items: THEME_ORDER.map((key) => ({ value: key, title: THEMES[key].label })),
      },
    },
  },
  parameters: {
    controls: { matchers: { color: /(background|color)$/i, date: /Date$/i } },
  },
};

export default preview;
