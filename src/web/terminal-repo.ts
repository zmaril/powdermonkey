import { useLiveQuery } from "@tanstack/react-db";
import type { Repo, Task } from "../server/schema.ts";
import type { SessionLink } from "./active.ts";
import { reposCollection, sessionTasksCollection, tasksCollection } from "./collections.ts";

// A terminal's repo context — the `owner/name` slug it runs against — resolved from its
// session. The GitHub-ref link provider (github-links.ts) needs this to point a bare
// `#123` at the right repo: a session attaches to one repo (via its session_tasks link
// to a task, and the task's pinned repo), so a #123 printed in that terminal means an
// issue/PR in that repo. Terminals across a multi-repo workspace each resolve to their
// own slug, so the same `#123` links to different repos in different panes.
//
// The rule (session → task → repoId → slug) is a pure function over the collection
// snapshots so it stays unit-testable; the hook just feeds it the live-synced data.

/** Resolve a session's repo slug: its session_tasks link → the task → the task's repo.
 *  Undefined when the terminal has no session (a supervisor/cwd shell), the link/task/repo
 *  hasn't synced, or the task pins no repo — the provider then leaves a bare ref unlinked
 *  (a qualified `owner/repo#123` still links). Any link resolves the same repo (one session
 *  = one repo), so the first is enough. */
export function slugForSession(
  sessionId: number | undefined,
  links: Pick<SessionLink, "sessionId" | "taskId">[],
  tasks: Pick<Task, "id" | "repoId">[],
  repos: Pick<Repo, "id" | "slug">[],
): string | undefined {
  if (sessionId == null) return undefined;
  const link = links.find((l) => l.sessionId === sessionId);
  if (!link) return undefined;
  const task = tasks.find((t) => t.id === link.taskId);
  if (task?.repoId == null) return undefined;
  return repos.find((r) => r.id === task.repoId)?.slug;
}

/** The terminal's repo-context slug, live off the synced collections — wraps slugForSession
 *  for ShellTerminal, which feeds it to the GitHub-ref provider so a bare `#123` resolves. */
export function useTerminalRepoSlug(session: number | undefined): string | undefined {
  const links = useLiveQuery(() => sessionTasksCollection).data ?? [];
  const tasks = useLiveQuery(() => tasksCollection).data ?? [];
  const repos = useLiveQuery(() => reposCollection).data ?? [];
  return slugForSession(session, links, tasks, repos);
}
