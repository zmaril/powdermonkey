import { Group } from "@mantine/core";
import { AgentsCluster } from "./status/AgentsCluster.tsx";
import { ClaudeUsageCluster } from "./status/ClaudeUsageCluster.tsx";
import { useAgentsRunning } from "./useAgentsRunning.ts";
import { useClaudeUsage } from "./useClaudeUsage.ts";

// The global status bar: a slim strip above every window carrying the two
// always-on-glance numbers — how many agents are running right now (left) and how much
// Claude the operator has left (right). It sits at the very top of the app, above the
// pane-launcher TopBar and the dockview, so it's visible whatever pane has focus. The
// agents count is reactive off the sessions collection; the usage reading is polled
// (see useClaudeUsage) and degrades to a dim "unavailable" when there's no login.

export function StatusBar() {
  const running = useAgentsRunning();
  const usage = useClaudeUsage();
  return (
    <div
      style={{
        flex: "0 0 auto",
        borderBottom: "1px solid var(--pm-hairline)",
        background: "var(--pm-tab-strip)",
      }}
    >
      <Group justify="space-between" px="md" py="tight" wrap="nowrap">
        <AgentsCluster running={running} />
        <ClaudeUsageCluster usage={usage} />
      </Group>
    </div>
  );
}
