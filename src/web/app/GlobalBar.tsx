import { Group } from "@mantine/core";
import { useClaudeUsage, useRunningAgents } from "../global-status.ts";
import { AgentsBadge } from "./AgentsBadge.tsx";
import { UsageMeter } from "./UsageMeter.tsx";

/** Always-on chrome above every window (docs/vocabulary.md → Global status bar).
 *  Supervisor-wide, not window-scoped: one supervisor sees every repo and session at
 *  once, so the shared constraints it surfaces — agents running across all repos, and
 *  Claude usage/limits — stay visible regardless of which window is in front. Sits at
 *  the very top of the app, above the pane toolbar (TopBar), as a slim strip. */
export function GlobalBar() {
  const running = useRunningAgents();
  const usage = useClaudeUsage();
  return (
    <div
      style={{
        flex: "0 0 auto",
        borderBottom: "1px solid var(--pm-hairline)",
        background: "var(--pm-surface)",
      }}
    >
      <Group justify="space-between" px="md" py="tight" wrap="nowrap" gap="md">
        <AgentsBadge running={running} />
        <UsageMeter usage={usage} />
      </Group>
    </div>
  );
}
