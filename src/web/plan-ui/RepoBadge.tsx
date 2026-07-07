import { Group, Text } from "@mantine/core";
import { useLiveQuery } from "@tanstack/react-db";
import { useState } from "react";
import type { Repo } from "../../server/schema.ts";
import { reposCollection, sessionTasksCollection, tasksCollection } from "../collections.ts";
import { repoSwatch } from "../repo-color.ts";
import { apiUrl } from "../server.ts";
import { useActiveTheme } from "../store.ts";

// The repo identity badge (docs/vocabulary.md § Repo → Identity): the repo's icon
// ringed in its theme-hashed color, falling back to a plain color dot when no icon
// resolved (GET /repos/:id/icon 404s), plus the repo name. One component so a repo
// looks the same on every surface that renders it — task cards, worker cards, and
// the session pane tabs.

/** A repo row by id, off the live-synced repos collection. Undefined for repo-less
 *  tasks (and while the snapshot is still loading) — callers just skip the badge. */
export function useRepo(repoId: number | null | undefined): Repo | undefined {
  const repos = useLiveQuery(() => reposCollection);
  if (repoId == null) return undefined;
  return (repos.data ?? []).find((r) => r.id === repoId);
}

/** The repo a session runs against — via its session_tasks link to a task and the
 *  task's pinned repo (one session = one repo; any link resolves the same repo). */
export function useSessionRepo(sessionId: number | null | undefined): Repo | undefined {
  const links = useLiveQuery(() => sessionTasksCollection);
  const tasks = useLiveQuery(() => tasksCollection);
  const repos = useLiveQuery(() => reposCollection);
  if (sessionId == null) return undefined;
  const link = (links.data ?? []).find((l) => l.sessionId === sessionId);
  const task = link ? (tasks.data ?? []).find((t) => t.id === link.taskId) : undefined;
  if (task?.repoId == null) return undefined;
  return (repos.data ?? []).find((r) => r.id === task.repoId);
}

/** Icon-in-a-color-ring + name. `showName` off gives the bare glyph for tight spots
 *  (dockview tabs). The color is resolved into the ACTIVE theme's swatches at render
 *  time (repo-color.ts), so badges re-skin with the theme. */
export function RepoBadge({ repo, showName = true }: { repo: Repo; showName?: boolean }) {
  const theme = useActiveTheme();
  const color = repoSwatch(repo, theme);
  // Whether /repos/:id/icon delivered. Starts optimistic: the ring paints the color
  // immediately while the icon loads, and a 404 swaps in the dot fallback.
  const [iconOk, setIconOk] = useState(true);
  return (
    <Group gap="tight" wrap="nowrap" style={{ flexShrink: 0 }} title={repo.slug}>
      {iconOk ? (
        <img
          src={apiUrl(`/repos/${repo.id}/icon`)}
          alt=""
          width={14}
          height={14}
          onError={() => setIconOk(false)}
          style={{ display: "block", borderRadius: 3, boxShadow: `0 0 0 1.5px ${color}` }}
        />
      ) : (
        <span
          aria-hidden
          style={{ width: 9, height: 9, borderRadius: "50%", background: color, flexShrink: 0 }}
        />
      )}
      {showName && (
        <Text size="xs" c="dimmed" truncate>
          {repo.name}
        </Text>
      )}
    </Group>
  );
}
