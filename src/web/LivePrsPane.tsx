import { Anchor, Badge, Box, Group, Stack, Text } from "@mantine/core";
import { useLiveQuery } from "@tanstack/react-db";
import { pullRequestsCollection } from "./pr-collection.ts";

// SPIKE pane — renders the pull_requests table straight off the TanStack DB
// collection that's fed by PGlite live.changes (see pr-collection.ts). No store, no
// poll, no refetch: useLiveQuery re-renders incrementally as deltas arrive. This
// exists to prove the embedded-PGlite → TanStack DB pipeline end to end; it's not
// wired into the real Active pane yet.

// CI rollup → a single status colour, GitHub-style.
const CHECK_COLOR: Record<string, string> = {
  SUCCESS: "teal",
  FAILURE: "red",
  ERROR: "red",
  PENDING: "yellow",
};

function statusColor(checks: string | null, mergeable: string | null): string {
  if (mergeable === "CONFLICTING") return "orange";
  return (checks && CHECK_COLOR[checks]) || "gray";
}

export function LivePrsPane() {
  // The whole pane is one live query over the synced collection. `() => collection`
  // subscribes to every row; differential dataflow updates only what changed.
  const { data, isLoading } = useLiveQuery(() => pullRequestsCollection);
  const prs = [...(data ?? [])].sort((a, b) => b.number - a.number);

  return (
    <Box style={{ height: "100%", background: "#1a1b1e", overflowY: "auto" }} p="sm">
      <Group gap={8} mb="sm" wrap="nowrap">
        <Text size="xs" c="dimmed" fw={700} style={{ letterSpacing: 0.5 }}>
          LIVE PRs
        </Text>
        <Badge size="sm" variant="light" color={prs.length > 0 ? "blue" : "gray"}>
          {prs.length}
        </Badge>
        <Text size="xs" c="dimmed">
          TanStack DB ⟵ PGlite live.changes
        </Text>
      </Group>

      {isLoading ? (
        <Text c="dimmed" size="sm">
          connecting…
        </Text>
      ) : prs.length === 0 ? (
        <Text c="dimmed" size="sm">
          No PRs yet — dispatch a task and open a PR, and it streams in here live.
        </Text>
      ) : (
        <Stack gap={6}>
          {prs.map((pr) => (
            <Group key={pr.number} gap="sm" wrap="nowrap" align="center">
              <Box
                style={{
                  width: 9,
                  height: 9,
                  borderRadius: "50%",
                  background: `var(--mantine-color-${statusColor(pr.checks, pr.mergeable)}-5)`,
                  flex: "0 0 auto",
                }}
              />
              <Anchor href={pr.url} target="_blank" size="sm" fw={600}>
                #{pr.number}
              </Anchor>
              <Text size="sm" truncate style={{ flex: 1, minWidth: 0 }}>
                {pr.title || "(untitled)"}
              </Text>
              {pr.merged ? (
                <Badge size="xs" color="grape" variant="light">
                  merged
                </Badge>
              ) : pr.isDraft ? (
                <Badge size="xs" color="gray" variant="light">
                  draft
                </Badge>
              ) : null}
              {pr.checks && (
                <Text size="xs" c="dimmed">
                  {pr.checks}
                </Text>
              )}
            </Group>
          ))}
        </Stack>
      )}
    </Box>
  );
}
