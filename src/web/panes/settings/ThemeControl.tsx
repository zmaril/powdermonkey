import { Box, Group, Stack, Text, UnstyledButton } from "@mantine/core";
import { useStore } from "../../store.ts";
import { getTheme, THEME_ORDER } from "../../themes.ts";

// The theme picker. One swatch-card per editor theme; clicking sets the store
// selection, which re-skins the whole app live (Mantine palette + dockview chrome +
// terminal). The swatches are drawn straight from each theme's own palette — page
// background carrying surface / accent / text chips — so the card previews what
// you'll get.
export function ThemeControl() {
  const current = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  return (
    <Group gap="sm">
      {THEME_ORDER.map((key) => {
        const t = getTheme(key);
        const selected = key === current;
        const accent = t.accent[t.primaryShade];
        const chips = [t.dark[6], accent, t.dark[0]];
        return (
          <UnstyledButton
            key={key}
            onClick={() => setTheme(key)}
            style={{
              borderRadius: 8,
              padding: 8,
              width: 132,
              border: `1px solid ${selected ? accent : "var(--mantine-color-dark-4)"}`,
              background: selected ? "var(--mantine-color-dark-6)" : "transparent",
              boxShadow: selected ? `0 0 0 1px ${accent}` : undefined,
            }}
          >
            <Stack gap="snug">
              <Box
                style={{
                  background: t.dark[7],
                  borderRadius: 5,
                  padding: 8,
                  border: `1px solid ${t.dark[4]}`,
                }}
              >
                <Group gap="tight" wrap="nowrap">
                  {chips.map((color, i) => (
                    <Box
                      // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length swatch row
                      key={i}
                      style={{ width: 22, height: 22, borderRadius: 4, background: color }}
                    />
                  ))}
                </Group>
              </Box>
              <Text size="xs" fw={selected ? 700 : 500} c={selected ? undefined : "dimmed"}>
                {t.label}
              </Text>
            </Stack>
          </UnstyledButton>
        );
      })}
    </Group>
  );
}
