import { Divider, Group, SegmentedControl, Stack, Text } from "@mantine/core";
import { DENSITY, FONT_SCALE } from "../../appearance.ts";
import { MOTION } from "../../motion.ts";
import { useStore } from "../../store.ts";
import { CommandRow } from "./CommandRow.tsx";
import { NotifyControl } from "./NotifyControl.tsx";
import { ThemeControl } from "./ThemeControl.tsx";

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
    <div
      style={{
        height: "100%",
        background: "var(--pm-pane-bg)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <Group px="md" py="cozy" style={{ flex: "0 0 auto" }}>
        <Text size="xs" c="dimmed" fw={700} style={{ letterSpacing: 0.5 }}>
          SETTINGS
        </Text>
      </Group>
      <Stack gap="lg" px="md" pb="md" style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
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
        <Stack gap="snug">
          <Text size="sm" fw={600}>
            Density
          </Text>
          <Text size="xs" c="dimmed">
            How tight the layout is — independent of the theme and font size.
          </Text>
          <SegmentedControl
            size="xs"
            value={density}
            onChange={setDensity}
            data={DENSITY.map((o) => ({ label: o.label, value: o.key }))}
            style={{ alignSelf: "flex-start" }}
          />
        </Stack>
        <Divider />
        <Stack gap="snug">
          <Text size="sm" fw={600}>
            Font size
          </Text>
          <Text size="xs" c="dimmed">
            Scales all text and controls — independent of the theme and density.
          </Text>
          <SegmentedControl
            size="xs"
            value={fontScale}
            onChange={setFontScale}
            data={FONT_SCALE.map((o) => ({ label: o.label, value: o.key }))}
            style={{ alignSelf: "flex-start" }}
          />
        </Stack>
        <Divider />
        <Stack gap="snug">
          <Text size="sm" fw={600}>
            Motion
          </Text>
          <Text size="xs" c="dimmed">
            How much the UI animates — Subtle softens it, Off stops it everywhere. (The OS "reduce
            motion" setting is always honored.)
          </Text>
          <SegmentedControl
            size="xs"
            value={motion}
            onChange={setMotion}
            data={MOTION.map((o) => ({ label: o.label, value: o.key }))}
            style={{ alignSelf: "flex-start" }}
          />
        </Stack>
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
            Open the tmux dashboard in your own terminal — one pane per live session, plus the
            server. The browser shell shows one agent at a time; this watches the whole machine.
          </Text>
          <CommandRow cmd="powdermonkey attach" hint="installed globally (npm i -g powdermonkey)" />
          <CommandRow cmd="bun run attach" hint="from a checkout" />
        </Stack>
      </Stack>
    </div>
  );
}
