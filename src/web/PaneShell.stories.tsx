// straitjacket-allow-file:one-component  a Storybook stories file exports several Story objects (Prose, WithControls) by design — that's the story catalog, not multiple React components crammed in one file
import { Button, Group, Text } from "@mantine/core";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { PaneShell } from "./PaneShell.tsx";

// PaneShell is the chrome the simple panes share (dimmed header + scrolling body), so
// it's worth a story on its own — it's where the surface treatment lives, and the one
// place to check header/body spacing against every theme.
const meta = {
  title: "Chrome/PaneShell",
  component: PaneShell,
  parameters: { layout: "fullscreen" },
  args: { title: "EXAMPLE" },
} satisfies Meta<typeof PaneShell>;

export default meta;

type Story = StoryObj<typeof meta>;

// A prose body, width-capped the way the About/Help panes render.
export const Prose: Story = {
  args: {
    bodyMaxWidth: 620,
    children: (
      <Text size="sm" c="dimmed">
        A capped prose column: this is what the About and Help panes drop into the shell. The header
        above is the shared dimmed, all-caps label; the body scrolls independently when it
        overflows.
      </Text>
    ),
  },
};

// A full-width body with interactive controls, to eyeball button/text contrast per theme.
export const WithControls: Story = {
  args: {
    children: (
      <Group>
        <Button>Primary</Button>
        <Button variant="default">Default</Button>
        <Button variant="subtle">Subtle</Button>
      </Group>
    ),
  },
};
