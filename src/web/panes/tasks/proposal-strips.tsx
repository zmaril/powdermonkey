import { Group, Text } from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";
import type { Phase } from "../../../server/schema.ts";
import { Decision, ProposalOp } from "../../../shared/types.ts";
import { type EntityEdit, editLabel, type Ghost } from "../../ghosts.ts";
import { ProposedStrip } from "./ProposedStrip.tsx";
import { useDecide } from "./useDecide.ts";

// The "Proposed: …" review strips, in the three shapes they take. Each owns a single
// useDecide() (one busy/conflict lifecycle per group of strips), so the callers don't
// repeat the accept/reject wiring — the strip layout and the decide plumbing live here.

/** How a proposed edit on one of a task's phases reads — with the phase's own name. */
function phaseEditLabel(e: EntityEdit, phases: Phase[]): string {
  const name = phases.find((p) => p.id === e.id)?.name ?? "this phase"; // lint-allow-string: display fallback, not the VocabKind
  if (e.op === ProposalOp.Archive) return `Proposed: delete phase "${name}"`;
  if (e.op === ProposalOp.Update) return `Proposed: rename phase → "${e.newTitle ?? ""}"`;
  return editLabel(e);
}

const hintFor = (proposalId: number, proposalTitle: string) =>
  `From proposal P${proposalId}: ${proposalTitle}`;

/** Edits on a node itself (rename / delete) — the strips on a goal or milestone header. */
export function EditStrips({ edits }: { edits: EntityEdit[] }) {
  const { busy, decide } = useDecide();
  return (
    <>
      {edits.map((e) => (
        <ProposedStrip
          key={`p${e.proposalId}-${e.changeIndex}`}
          label={editLabel(e)}
          hint={hintFor(e.proposalId, e.proposalTitle)}
          busy={busy}
          onAccept={() => decide(e.proposalId, e.changeIndex, Decision.Accept)}
          onReject={() => decide(e.proposalId, e.changeIndex, Decision.Reject)}
        />
      ))}
    </>
  );
}

/** The single accept/reject strip under a ghost (proposed new) node. */
export function GhostStrip({ ghost, label }: { ghost: Ghost; label: string }) {
  const { busy, decide } = useDecide();
  return (
    <ProposedStrip
      label={label}
      hint={hintFor(ghost.proposalId, ghost.proposalTitle)}
      busy={busy}
      onAccept={() => decide(ghost.proposalId, ghost.changeIndex, Decision.Accept)}
      onReject={() => decide(ghost.proposalId, ghost.changeIndex, Decision.Reject)}
    />
  );
}

/** Every pending change on a task and its phases, as a run of strips: edits on the task
 *  (rename / delete), proposed new phases, and edits on existing phases. `showConflict`
 *  surfaces a decide() conflict inline (the card wants it; the dense row doesn't). */
export function TaskProposalStrips({
  edits,
  phaseGhosts,
  phaseEdits,
  phases,
  showConflict = false,
}: {
  edits: EntityEdit[];
  phaseGhosts: Ghost[];
  phaseEdits: EntityEdit[];
  phases: Phase[];
  showConflict?: boolean;
}) {
  const { busy, conflict, decide } = useDecide();
  const strip = (key: string, label: string, hint: string, proposalId: number, ix: number) => (
    <ProposedStrip
      key={key}
      label={label}
      hint={hint}
      busy={busy}
      onAccept={() => decide(proposalId, ix, Decision.Accept)}
      onReject={() => decide(proposalId, ix, Decision.Reject)}
    />
  );
  return (
    <>
      {edits.map((e) =>
        strip(
          `p${e.proposalId}-${e.changeIndex}`,
          editLabel(e),
          hintFor(e.proposalId, e.proposalTitle),
          e.proposalId,
          e.changeIndex,
        ),
      )}
      {phaseGhosts.map((g) =>
        strip(
          `p${g.proposalId}-${g.changeIndex}`,
          `Proposed: add phase "${g.title}"`,
          hintFor(g.proposalId, g.proposalTitle),
          g.proposalId,
          g.changeIndex,
        ),
      )}
      {phaseEdits.map((e) =>
        strip(
          `p${e.proposalId}-${e.changeIndex}`,
          phaseEditLabel(e, phases),
          hintFor(e.proposalId, e.proposalTitle),
          e.proposalId,
          e.changeIndex,
        ),
      )}
      {showConflict && conflict && (
        <Group
          mt="snug"
          gap="tight"
          wrap="nowrap"
          // Scheme-aware so the warning reads on a light card too (orange.4 is a pale
          // tint that washes out on white); darker orange on light, the tint on dark.
          style={{
            color: "light-dark(var(--mantine-color-orange-8), var(--mantine-color-orange-4))",
          }}
        >
          <IconAlertTriangle size={14} style={{ flexShrink: 0 }} />
          <Text size="xs">{conflict}</Text>
        </Group>
      )}
    </>
  );
}
