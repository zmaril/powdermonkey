import { Divider, SegmentedControl, Stack, Text } from "@mantine/core";
import { PaneShell } from "../../PaneShell.tsx";
import { DENSITY, FONT_SCALE } from "../../appearance.ts";
import { MOTION } from "../../motion.ts";
import { useStore } from "../../store.ts";
import { CommandRow } from "./CommandRow.tsx";
import { NotifyControl } from "./NotifyControl.tsx";
import { ServerControl } from "./ServerControl.tsx";
import { ThemeControl } from "./ThemeControl.tsx";

// One appearance axis: a labelled, described SegmentedControl. Density, font size and
// motion are all this exact shape; only the option set + bound store value differ.
function SegmentedSetting({
  title,
  description,
  value,
  onChange,
  options,
}: {
  title: string;
  description: string;
  value: string;
  onChange: (v: string) => void;
  options: { key: string; label: string }[];
}) {
  return (
    <Stack gap="snug">
      <Text size="sm" fw={600}>
        {title}
      </Text>
      <Text size="xs" c="dimmed">
        {description}
      </Text>
      <SegmentedControl
        size="xs"
        value={value}
        onChange={onChange}
        data={options.map((o) => ({ label: o.label, value: o.key }))}
        style={{ alignSelf: "flex-start" }}
      />
    </Stack>
  );
}

// The Settings pane: cross-cutting controls that aren't tied to a particular task —
// the four independent appearance axes (theme / density / font size / motion), desktop
// notifications and the tmux "attach" command. Opened from the top bar like any pane.
export function SettingsPane() {
  const density = useStore((s) => s.density);
  const setDensity = useStore((s) => s.setDensity);
  const fontScale = useStore((s) => s.fontScale);
  const setFontScale = useStore((s) => s.setFontScale);
  const motion = useStore((s) => s.motion);
  const setMotion = useStore((s) => s.setMotion);
  return (
    <PaneShell title="SETTINGS" bodyGap="lg">
      <ServerControl />
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
        value={density}
        onChange={setDensity}
        options={DENSITY}
      />
      <Divider />
      <SegmentedSetting
        title="Font size"
        description="Scales all text and controls — independent of the theme and density."
        value={fontScale}
        onChange={setFontScale}
        options={FONT_SCALE}
      />
      <Divider />
      <SegmentedSetting
        title="Motion"
        description={
          'How much the UI animates — Subtle softens it, Off stops it everywhere. (The OS "reduce motion" setting is always honored.)'
        }
        value={motion}
        onChange={setMotion}
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
