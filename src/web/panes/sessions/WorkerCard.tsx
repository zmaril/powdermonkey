import { Anchor, Box, Card, Group, Stack, Text } from "@mantine/core";
import { IconExternalLink } from "@tabler/icons-react";
import { useState } from "react";
import type { Session, Task } from "../../../server/schema.ts";
import type { MailInfo } from "../../../shared/session-events.ts";
import { SessionKind } from "../../../shared/types.ts";
import { Markdown } from "../../markdown.tsx";
import type { Indexes } from "../../plan-data.ts";
import {
  KIND_ICON,
  PrRow,
  RepoBadge,
  SessionActions,
  SessionStateBadge,
  useRepo,
} from "../../plan-ui";
import { timeAgo } from "../../time.ts";
import { ColumnLabel } from "./ColumnLabel.tsx";
import { contextOf, workerPrs } from "./grouping.ts";
import { type ComposerReply, SessionComposer } from "./SessionComposer.tsx";
import { SessionEventFeed } from "./SessionEventFeed.tsx";
import { TaskLine } from "./TaskLine.tsx";

/** One worker = one card. The header holds everything session-level (kind · state ·
 *  shared context · session link · Teleport · Stop); the task(s) the worker is
 *  running nest below. Single- and multi-task workers render the same way, so the
 *  pane is visually consistent. `showContext` puts the shared goal › milestone trail
 *  in the header (flat view); under grouped headings it's redundant, so it's off —
 *  and if a worker spans milestones, each task line carries its own context. */
export function WorkerCard({
  session,
  tasks,
  idx,
  showContext,
}: {
  session: Session;
  tasks: Task[];
  idx: Indexes;
  showContext: boolean;
}) {
  const contexts = showContext ? [...new Set(tasks.map((t) => contextOf(t, idx)))] : [];
  const sharedContext = contexts.length === 1 ? contexts[0] : undefined;
  const perTaskContext = contexts.length > 1;
  const prs = workerPrs(tasks, idx);
  // The PR carrying the agent's freshest comment (usually the worker has one PR).
  const commentPr = prs.find((p) => p.lastComment);
  const KindIcon = KIND_ICON[session.kind];
  // The repo this worker runs against — one session = one repo, so any task's
  // pinned repo is THE repo. Undefined for repo-less (pre-registry) tasks.
  const repo = useRepo(tasks[0]?.repoId);
  // A Reply on a worker's "needs a decision" mail card seeds the composer (below it) with
  // the answer threaded (`inReplyTo`) to that question — the target is the worker's own
  // session, which the composer already sends to. `token` re-fires the seed per click.
  const [reply, setReply] = useState<ComposerReply | null>(null);
  const onReply = (mail: MailInfo) =>
    setReply({ messageId: mail.messageId, body: "", token: Date.now() });
  // A historical session (landed / stopped / teleported) is archived: its state badge
  // is the outcome, and the live-only controls (Shell/VS Code/Teleport/Stop) no longer
  // apply, so they drop off. The card still shows its tasks, PRs and final agent status.
  const live = session.archivedAt == null;
  return (
    <Card withBorder radius="md" padding="sm" bg="dark.5" data-pm-reveal={`s${session.id}`}>
      {/* Top: session status + controls, full width. */}
      <Group justify="space-between" wrap="nowrap" align="flex-start" mb="xs">
        <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
          <KindIcon size={15} title={session.kind} style={{ flexShrink: 0 }} />
          <SessionStateBadge session={session} />
          {repo && <RepoBadge repo={repo} />}
          {sharedContext && (
            <Text size="xs" c="dimmed" truncate>
              {sharedContext}
            </Text>
          )}
        </Group>
        {live && tasks.length > 0 && <SessionActions session={session} taskId={tasks[0].id} />}
      </Group>

      {/* Bottom: left half = tasks + PRs, right half = the agent's last comment. */}
      <Group align="flex-start" grow wrap="nowrap" gap="lg">
        <Stack gap="xs" style={{ minWidth: 0 }}>
          <Stack gap="snug">
            <ColumnLabel>Tasks</ColumnLabel>
            {tasks.map((t) => (
              <TaskLine
                key={t.id}
                task={t}
                context={perTaskContext ? contextOf(t, idx) : undefined}
              />
            ))}
          </Stack>
          <Stack gap="snug">
            <ColumnLabel>PRs</ColumnLabel>
            {prs.length === 0 ? (
              <Text size="xs" c="dimmed">
                none yet
              </Text>
            ) : (
              prs.map((pr) => <PrRow key={pr.number} pr={pr} />)
            )}
          </Stack>
        </Stack>
        <Stack gap="snug" style={{ minWidth: 0 }}>
          {session.kind === SessionKind.Remote ? (
            // A disponent-managed worker surfaces its LIVE event feed (drained from
            // disponent's stream — see disponent-feed.ts) plus a composer to send it
            // input, instead of relying on PR comments alone. The composer only shows
            // on a live session; a historical one keeps the feed as a read-only record.
            <>
              <ColumnLabel>Agent Status</ColumnLabel>
              <SessionEventFeed session={session} onReply={live ? onReply : undefined} />
              {live && (
                <SessionComposer
                  session={session}
                  reply={reply}
                  onReplyConsumed={() => setReply(null)}
                />
              )}
            </>
          ) : (
            <>
              <Group gap="snug" justify="space-between" wrap="nowrap">
                <Group gap="snug" wrap="nowrap">
                  <ColumnLabel>Agent Status</ColumnLabel>
                  {commentPr?.lastCommentUrl && (
                    <Anchor
                      href={commentPr.lastCommentUrl}
                      target="_blank"
                      title="View on GitHub"
                      style={{ display: "inline-flex", lineHeight: 1 }}
                    >
                      <IconExternalLink size={14} />
                    </Anchor>
                  )}
                </Group>
                {commentPr?.lastCommentAt && (
                  <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
                    {timeAgo(commentPr.lastCommentAt)}
                  </Text>
                )}
              </Group>
              {commentPr?.lastComment ? (
                <Box style={{ maxHeight: 240, overflowY: "auto" }}>
                  <Markdown source={commentPr.lastComment} />
                </Box>
              ) : (
                <Text size="xs" c="dimmed">
                  — nothing yet
                </Text>
              )}
            </>
          )}
        </Stack>
      </Group>
    </Card>
  );
}
