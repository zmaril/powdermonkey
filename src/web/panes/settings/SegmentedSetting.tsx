import { SegmentedControl, Stack, Text } from "@mantine/core";
import { type State, useStore } from "../../store.ts";

// One appearance axis: a labelled, described SegmentedControl. Density, font size and
// motion are all this exact shape; only the option set + bound store slice differ, so
// the control reads its own value + setter from the store (like the sibling controls)
// rather than having SettingsPane drill them in.
export function SegmentedSetting({
  title,
  description,
  value,
  setter,
  options,
}: {
  title: string;
  description: string;
  /** Selects this axis's current value from the store (e.g. `(s) => s.density`). */
  value: (s: State) => string;
  /** Selects this axis's setter from the store (e.g. `(s) => s.setDensity`). */
  setter: (s: State) => (v: string) => void;
  options: { key: string; label: string }[];
}) {
  const current = useStore(value);
  const onChange = useStore(setter);
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
        value={current}
        onChange={onChange}
        data={options.map((o) => ({ label: o.label, value: o.key }))}
        style={{ alignSelf: "flex-start" }}
      />
    </Stack>
  );
}
