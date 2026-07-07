import { Group } from "@mantine/core";
import { TaskKind } from "../../../shared/types.ts";
import { KindBadge } from "../../plan-ui";
import { Added } from "./Added.tsx";
import { Arrow } from "./Arrow.tsx";
import { PROPOSED_HIGHLIGHT_BG } from "./constants.ts";
import { Removed } from "./Removed.tsx";

/** The kind badge in its after-state. Unchanged → the plain badge (nothing for a plain
 *  `task`). Changed → old (struck, if it had one) → new (ringed teal, or a teal "task"
 *  chip when the new kind is the badge-less default) so a retag is never silent. */
export function KindDiff({
  before,
  after,
  changed,
}: {
  before: TaskKind;
  after: TaskKind;
  changed: boolean;
}) {
  if (!changed) return <KindBadge kind={after} />;
  const hadBadge = before !== TaskKind.Task;
  const hasBadge = after !== TaskKind.Task;
  return (
    <Group gap="hair" wrap="nowrap" style={{ flexShrink: 0 }}>
      {hadBadge && (
        <Removed>
          <KindBadge kind={before} />
        </Removed>
      )}
      {hadBadge && <Arrow />}
      {hasBadge ? (
        <span
          style={{
            display: "inline-flex",
            borderRadius: 999,
            boxShadow: `0 0 0 2px ${PROPOSED_HIGHLIGHT_BG}`,
          }}
        >
          <KindBadge kind={after} />
        </span>
      ) : (
        <Added>task</Added>
      )}
    </Group>
  );
}
