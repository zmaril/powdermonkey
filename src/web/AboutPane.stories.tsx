import type { Meta, StoryObj } from "@storybook/react-vite";
import { AboutPane } from "./AboutPane.tsx";

// The About pane is pure presentation, so it's a good first story: pick a theme in the
// toolbar and watch the whole surface re-skin, no server or store needed.
const meta = {
  title: "Panes/About",
  component: AboutPane,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof AboutPane>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
