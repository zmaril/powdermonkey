import { Group } from "@mantine/core";
import type { BackendUsage } from "../../../server/disponent-usage.ts";
import { BackendMeter } from "./BackendMeter.tsx";

// The per-backend half of the status bar: for each dispatch backend with live
// sessions, a compact token + cost readout folded from disponent's Usage event
// stream (see server/disponent-usage.ts). Additive glance only — it reads a
// truthful $0 / 0 tok when disponent hasn't emitted usage yet, and hides entirely
// when no backend has a session, so it never clutters the bar.

export function BackendUsageCluster({ backends }: { backends: BackendUsage[] | null }) {
  // Nothing to show until a backend has a live session — stay invisible rather than
  // occupy the bar with an empty note (unlike Claude usage, this is opt-in signal).
  const active = (backends ?? []).filter((b) => b.sessions > 0);
  if (active.length === 0) return null;
  return (
    <Group gap="md" wrap="nowrap">
      {active.map((b) => (
        <BackendMeter key={b.backend} usage={b} />
      ))}
    </Group>
  );
}
