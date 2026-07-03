import { Anchor, Box, Group, Text } from "@mantine/core";
import type { CloudPr } from "../../server/events.ts";
import { CheckRollupState, MergeableState } from "../../shared/types.ts";
import { useStore } from "../store.ts";
import { AgentNarrative } from "./AgentNarrative.tsx";
import { AgentStateBadge } from "./AgentStateBadge.tsx";

/** One GitHub-style status dot folding CI + mergeability into a single glance:
 *  conflicts / CI failure → red, CI running → yellow, passing or no-conflicts →
 *  green, merged → violet, nothing-known-yet → gray. */
function prDot(pr: CloudPr): { color: string; title: string } {
  if (pr.merged) return { color: "violet", title: "merged" }; // lint-allow-string: hover title
  if (pr.mergeable === MergeableState.Conflicting)
    return { color: "red", title: "merge conflicts" };
  if (pr.checks === CheckRollupState.Failure || pr.checks === CheckRollupState.Error)
    return { color: "red", title: "CI failing" };
  if (pr.checks === CheckRollupState.Pending || pr.checks === CheckRollupState.Expected)
    return { color: "yellow", title: "CI running" };
  if (pr.checks === CheckRollupState.Success) return { color: "green", title: "CI passing" };
  if (pr.mergeable === MergeableState.Mergeable) return { color: "green", title: "no conflicts" };
  return { color: "gray", title: "no status yet" };
}

/** One PR row in a worker card: a status dot (CI + conflicts, GitHub-style) · the
 *  #number (link) · the title · the worker's agent-state chip. The agent's narrative
 *  (summary / next, with the full sticky comment on expand) sits below the row. */
export function PrRow({ pr }: { pr: CloudPr }) {
  const dot = prDot(pr);
  const openReview = useStore((s) => s.openReview);
  return (
    <Box>
      <Group gap="xs" wrap="nowrap">
        <Box
          w={8}
          h={8}
          title={dot.title}
          style={{
            borderRadius: "50%",
            background: `var(--mantine-color-${dot.color}-6)`,
            flexShrink: 0,
          }}
        />
        <Anchor
          href={pr.url}
          target="_blank"
          size="sm"
          fw={600}
          ff="monospace"
          style={{ flexShrink: 0 }}
        >
          #{pr.number}
        </Anchor>
        <Text size="sm" truncate style={{ flex: 1, minWidth: 0 }}>
          {pr.title}
        </Text>
        <Anchor
          component="button"
          size="sm"
          fw={500}
          onClick={() => openReview(pr.number, pr.title, pr.repo)}
          title="Review this PR's diff and inline comments in-app"
          style={{ flexShrink: 0 }}
        >
          Review
        </Anchor>
        {pr.agent && <AgentStateBadge agent={pr.agent} />}
      </Group>
      {pr.agent && <AgentNarrative agent={pr.agent} />}
    </Box>
  );
}
