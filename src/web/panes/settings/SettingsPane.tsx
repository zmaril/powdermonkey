import { Divider, Stack, Text } from "@mantine/core";
import { DENSITY, FONT_SCALE } from "../../appearance.ts";
import { MOTION } from "../../motion.ts";
import { PaneShell } from "../../PaneShell.tsx";
import { CommandRow } from "./CommandRow.tsx";
import { DispatchControl } from "./DispatchControl.tsx";
import { NotifyControl } from "./NotifyControl.tsx";
import { SegmentedSetting } from "./SegmentedSetting.tsx";
import { ServerControl } from "./ServerControl.tsx";
import { ThemeControl } from "./ThemeControl.tsx";

// The Settings pane: cross-cutting controls that aren't tied to a particular task —
// the four independent appearance axes (theme / density / font size / motion), desktop
// notifications and the tmux "attach" command. Opened from the top bar like any pane.
export function SettingsPane() {
  return (
    <PaneShell title="SETTINGS" bodyGap="lg">
      <ServerControl />
      <Divider />
      <DispatchControl />
      <Divider />
      <Stack gap="snug">
        <Text size="sm" fw={600}>
          Theme
        </Text>
        <Text size="xs" c="dimmed">
          A classic code-editor palette, applied across the dock, panes and terminal.
        </Text>
        <ThemeControl />
      </Stack>
      <Divider />
      <SegmentedSetting
        title="Density"
        description="How tight the layout is — independent of the theme and font size."
        value={(s) => s.density}
        setter={(s) => s.setDensity}
        options={DENSITY}
      />
      <Divider />
      <SegmentedSetting
        title="Font size"
        description="Scales all text and controls — independent of the theme and density."
        value={(s) => s.fontScale}
        setter={(s) => s.setFontScale}
        options={FONT_SCALE}
      />
      <Divider />
      <SegmentedSetting
        title="Motion"
        description={
          'How much the UI animates — Subtle softens it, Off stops it everywhere. (The OS "reduce motion" setting is always honored.)'
        }
        value={(s) => s.motion}
        setter={(s) => s.setMotion}
        options={MOTION}
      />
      <Divider />
      <Stack gap="snug">
        <Text size="sm" fw={600}>
          Notifications
        </Text>
        <NotifyControl />
      </Stack>
      <Divider />
      <Stack gap="snug">
        <Text size="sm" fw={600}>
          Attach
        </Text>
        <Text size="xs" c="dimmed">
          Open the tmux dashboard in your own terminal — one pane per live session, plus the server.
          The browser shell shows one agent at a time; this watches the whole machine.
        </Text>
        <CommandRow cmd="powdermonkey attach" hint="installed globally (npm i -g powdermonkey)" />
        <CommandRow cmd="bun run attach" hint="from a checkout" />
      </Stack>
    </PaneShell>
  );
}
