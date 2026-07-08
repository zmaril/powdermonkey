import { Group, Text, Tooltip } from "@mantine/core";
import type { BackendUsage } from "../../../server/disponent-usage.ts";
import { SessionKind } from "../../../shared/types.ts";

// The per-backend half of the status bar: for each dispatch backend with live
// sessions, a compact token + cost readout folded from disponent's Usage event
// stream (see server/disponent-usage.ts). Additive glance only — it reads a
// truthful $0 / 0 tok when disponent hasn't emitted usage yet, and hides entirely
// when no backend has a session, so it never clutters the bar.

/** Human label for a backend kind — apart from the raw enum value so the bar reads
 *  nicely ("Remote" not "remote"). */
function backendLabel(kind: SessionKind): string {
  if (kind === SessionKind.Remote) return "Remote";
  if (kind === SessionKind.Local) return "Local";
  return kind;
}

/** Compact token count: 1_234 → "1.2k", 2_500_000 → "2.5M". Bare digits under 1k. */
function compactTokens(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Fractional cents → a dollar string ($0.42, $12.30). */
function dollars(costCents: number): string {
  return `$${(costCents / 100).toFixed(2)}`;
}

function BackendMeter({ usage }: { usage: BackendUsage }) {
  const label = backendLabel(usage.backend);
  return (
    <Tooltip
      label={`${label}: ${usage.sessions} session(s) · ${usage.inputTokens.toLocaleString()} in / ${usage.outputTokens.toLocaleString()} out tokens`}
      withArrow
    >
      <Group gap="snug" wrap="nowrap" align="center">
        <Text size="xs" c="dimmed">
          {label}
        </Text>
        <Text size="xs">{dollars(usage.costCents)}</Text>
        <Text size="xs" c="dimmed">
          {compactTokens(usage.inputTokens + usage.outputTokens)} tok
        </Text>
      </Group>
    </Tooltip>
  );
}

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
