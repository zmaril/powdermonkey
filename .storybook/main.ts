import type { StorybookConfig } from "@storybook/react-vite";

// Storybook renders the React/Mantine components in a real browser in isolation, so you
// can build and eyeball a pane without booting the whole server + PGlite + dock. It's
// also where the visual snapshots come from (see docs) — one browser pass over every
// story, rather than a browser per test. Stories live next to the components they cover
// under src/web.
const config: StorybookConfig = {
  stories: ["../src/web/**/*.stories.@(ts|tsx)"],
  framework: { name: "@storybook/react-vite", options: {} },
};

export default config;
