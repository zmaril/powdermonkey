import { Group, List, Text, ThemeIcon } from "@mantine/core";
import { IconCheck, IconMinus, IconPlus, IconPoint } from "@tabler/icons-react";
import { PhaseStatus } from "../../../shared/types.ts";
import { Added } from "./Added.tsx";
import { Arrow } from "./Arrow.tsx";
import { DecideControls } from "./DecideControls.tsx";
import type { PhaseRow } from "./preview.ts";
import { Removed } from "./Removed.tsx";

// The glyph for a previewed phase row, chosen by what the proposal does to it: a teal +
// for an added phase, a struck − for a deleted one, otherwise the plain todo/done dot.
function rowGlyph(row: PhaseRow) {
  if (row.status === "added") return { color: "teal", Icon: IconPlus };
  if (row.status === "removed") return { color: "red", Icon: IconMinus };
  if (row.phase.status === PhaseStatus.Done) return { color: "green", Icon: IconCheck };
  return { color: "gray", Icon: IconPoint };
}

/** The task's checklist rendered as it WILL be: each phase in its after-state (renamed
 *  old → new, added highlighted, removed struck) with a per-row accept/reject for the
 *  phase-level change. A row with no pending change renders as a plain phase. */
export function PreviewPhaseList({ rows }: { rows: PhaseRow[] }) {
  if (rows.length === 0) return null;
  return (
    <List spacing="hair" size="sm" center>
      {rows.map((row) => {
        const g = rowGlyph(row);
        return (
          <List.Item
            key={row.key}
            icon={
              <ThemeIcon color={g.color} size={16} radius="xl">
                <g.Icon size={11} />
              </ThemeIcon>
            }
          >
            <Group gap="snug" wrap="nowrap" align="baseline" justify="space-between">
              <Text size="sm" style={{ wordBreak: "break-word", flex: 1, minWidth: 0 }}>
                {row.status === "removed" ? (
                  <Removed>{row.phase.name}</Removed>
                ) : row.status === "renamed" && row.before != null ? (
                  <>
                    <Removed>{row.before}</Removed>
                    <Arrow />
                    <Added>{row.phase.name}</Added>
                  </>
                ) : row.status === "added" ? (
                  <Added>{row.phase.name}</Added>
                ) : (
                  row.phase.name
                )}
              </Text>
              {row.change && <DecideControls changes={[row.change]} compact />}
            </Group>
          </List.Item>
        );
      })}
    </List>
  );
}
