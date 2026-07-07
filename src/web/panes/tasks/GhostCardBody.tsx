import { Text } from "@mantine/core";
import type { Phase } from "../../../server/schema.ts";
import { PhaseStatus, type TaskKind } from "../../../shared/types.ts";
import type { Ghost } from "../../ghosts.ts";
import { KindBadge, PhaseList } from "../../plan-ui";
import { GhostCard } from "./GhostCard.tsx";

/** A proposed new task, rendered like a real card in its after-state (same title font +
 *  kind badge + description + phase list) but dashed-teal with the accept/reject footer —
 *  so it reads as the peer it will become while still being clearly not-yet-real. */
export function GhostCardBody({ ghost }: { ghost: Ghost }) {
  const ghostPhases = ghost.phases.map(
    (name, i) => ({ id: -(i + 1), name, status: PhaseStatus.Todo }) as unknown as Phase,
  );
  const kind = (ghost.taskKind as TaskKind | undefined) ?? undefined;
  return (
    <GhostCard
      ghost={ghost}
      titleWeight={500}
      label="Proposed: new task"
      badge={kind ? <KindBadge kind={kind} /> : undefined}
    >
      {ghost.description && (
        <Text size="sm" c="dimmed" mb="snug" style={{ whiteSpace: "pre-wrap" }}>
          {ghost.description}
        </Text>
      )}
      <PhaseList phases={ghostPhases} />
    </GhostCard>
  );
}
