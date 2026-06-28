import { Badge, Group } from "@mantine/core";
import type { AgentStatus } from "../../server/events.ts";
import { AgentState } from "../../shared/types.ts";

// The worker's self-reported state → a compact chip colour. Typed Record<AgentState,…>
// so adding a state is a compile error here until it has a colour — the same
// total-coverage guarantee KIND_ICON / SESSION_BADGE rely on. An unrecognised status
// word is parsed to state:null upstream (no chip), so there's no open-string case here.
const AGENT_BADGE: Record<AgentState, { color: string }> = {
  [AgentState.Starting]: { color: "blue" },
  [AgentState.Working]: { color: "blue" },
  [AgentState.Blocked]: { color: "red" },
  [AgentState.Done]: { color: "green" },
};

/** The agent-authored state chip, plus the needs-you flag. `blocked` is the needs-you
 *  signal — a loud filled chip plus an explicit "needs you" badge so a blocked worker
 *  can't be missed. Renders nothing until the worker has posted a known status. */
export function AgentStateBadge({ agent }: { agent: AgentStatus }) {
  if (!agent.state) return null;
  const blocked = agent.state === AgentState.Blocked;
  const color = AGENT_BADGE[agent.state].color;
  return (
    <Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
      <Badge
        size="xs"
        variant={blocked ? "filled" : "light"}
        color={color}
        title={agent.summary ?? `agent: ${agent.state}`}
      >
        {agent.state}
      </Badge>
      {blocked && (
        <Badge
          size="xs"
          variant="filled"
          color="orange"
          title={agent.summary ?? "The worker is blocked and needs you."}
        >
          needs you
        </Badge>
      )}
    </Group>
  );
}
