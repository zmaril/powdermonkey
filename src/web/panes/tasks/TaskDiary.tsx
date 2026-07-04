import { Box, Group, Stack, Text, TextInput, Tooltip, UnstyledButton } from "@mantine/core";
import { IconRobot } from "@tabler/icons-react";
import { useLiveQuery } from "@tanstack/react-db";
import { useEffect, useMemo, useRef, useState } from "react";
import type { TaskComment } from "../../../server/schema.ts";
import { CommentAuthor } from "../../../shared/types.ts";
import { taskCommentsCollection } from "../../collections.ts";
import { EditableText } from "../../plan-ui";
import { useStore } from "../../store.ts";
import { exactTime, timeAgo } from "../../time.ts";

// The task's diary: its comments rendered chronologically, compact and unobtrusive
// under the phase list, with a zero-ceremony one-line composer below — type + Enter
// appends, auto-timestamped, no modal / title / fields. Relative stamps ("2d ago")
// with the exact moment on hover; a long diary collapses to its newest lines behind
// an "earlier" toggle. A line stays an ordinary row after capture: click its text to
// edit in place, × archives it (the soft delete everything else uses). Deliberately
// no formatting and no required fields: muttering, not documenting.

/** Above this many lines the diary collapses to the newest TAIL. */
const COLLAPSE_ABOVE = 4;
const TAIL = 3;

/** Sort key: the diary reads oldest→newest, ties broken by insertion order. */
const byTime = (a: TaskComment, b: TaskComment) =>
  new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() || a.id - b.id;

/** One task's live (non-archived) comments, chronological, off the synced
 *  collection. The collection streams every row including archived ones — the
 *  filter here is what makes × take effect instantly. */
export function useTaskComments(taskId: number): TaskComment[] {
  const all = useLiveQuery(() => taskCommentsCollection);
  return useMemo(
    () => (all.data ?? []).filter((c) => c.taskId === taskId && c.archivedAt == null).sort(byTime),
    [all.data, taskId],
  );
}

/** True when a line has been edited since it was written (worth a subtle mark). */
const wasEdited = (c: TaskComment) =>
  new Date(c.updatedAt).getTime() - new Date(c.createdAt).getTime() > 1000;

/** One diary line: (supervisor glyph ·) click-to-edit body · relative stamp · archive ×. */
function DiaryLine({
  comment,
  onEdit,
  onArchive,
}: {
  comment: TaskComment;
  onEdit: (body: string) => void;
  onArchive: () => void;
}) {
  const supervisor = comment.author === CommentAuthor.Supervisor;
  return (
    <Group gap="tight" wrap="nowrap" align="baseline">
      {supervisor && (
        <Tooltip label="the supervisor" withArrow openDelay={300}>
          <Text component="span" c="violet.4" style={{ flexShrink: 0, lineHeight: 1 }}>
            <IconRobot size={12} />
          </Text>
        </Tooltip>
      )}
      <Box style={{ flex: 1, minWidth: 0 }}>
        <EditableText value={comment.body} size="xs" wrap onSave={onEdit} />
      </Box>
      {wasEdited(comment) && (
        <Tooltip label={`edited ${exactTime(comment.updatedAt)}`} withArrow openDelay={300}>
          <Text size="xs" c="dimmed" style={{ flexShrink: 0, opacity: 0.6, cursor: "default" }}>
            edited
          </Text>
        </Tooltip>
      )}
      <Tooltip label={exactTime(comment.createdAt)} withArrow openDelay={300}>
        <Text size="xs" c="dimmed" style={{ flexShrink: 0, cursor: "default" }}>
          {timeAgo(comment.createdAt)}
        </Text>
      </Tooltip>
      <UnstyledButton onClick={onArchive} title="archive this line">
        <Text size="xs" c="dimmed" style={{ opacity: 0.5 }}>
          ×
        </Text>
      </UnstyledButton>
    </Group>
  );
}

/** An optimistic echo: a line shown the instant Enter is hit, swapped out once the
 *  real row streams back over sync. `realId` arrives when the POST resolves. */
type PendingLine = { key: number; body: string; at: Date; realId?: number };

let pendingSeq = 0;

/** The timeline: every line when short; the newest TAIL behind an "n earlier lines"
 *  toggle when long. Renders nothing for an empty diary. Pending lines (optimistic
 *  echoes from the composer) always show, dimmed, at the bottom. */
function DiaryTimeline({ taskId, pending }: { taskId: number; pending: PendingLine[] }) {
  const comments = useTaskComments(taskId);
  const { updateComment, archiveComment } = useStore();
  const [expanded, setExpanded] = useState(false);
  if (comments.length === 0 && pending.length === 0) return null;

  const collapsed = !expanded && comments.length > COLLAPSE_ABOVE;
  const shown = collapsed ? comments.slice(-TAIL) : comments;
  const hidden = comments.length - shown.length;

  return (
    <Stack gap="hair" mt="snug">
      {collapsed && (
        <UnstyledButton onClick={() => setExpanded(true)}>
          <Text size="xs" c="dimmed">
            … {hidden} earlier line{hidden === 1 ? "" : "s"}
          </Text>
        </UnstyledButton>
      )}
      {shown.map((c) => (
        <DiaryLine
          key={c.id}
          comment={c}
          onEdit={(body) => updateComment(taskId, c.id, body)}
          onArchive={() => archiveComment(taskId, c.id)}
        />
      ))}
      {pending.map((p) => (
        <Group key={`pending-${p.key}`} gap="tight" wrap="nowrap" align="baseline">
          <Text size="xs" c="dimmed" style={{ wordBreak: "break-word", flex: 1, minWidth: 0 }}>
            {p.body}
          </Text>
          <Text size="xs" c="dimmed" style={{ flexShrink: 0, opacity: 0.6 }}>
            {timeAgo(p.at)}
          </Text>
        </Group>
      ))}
      {expanded && comments.length > COLLAPSE_ABOVE && (
        <UnstyledButton onClick={() => setExpanded(false)}>
          <Text size="xs" c="dimmed">
            collapse
          </Text>
        </UnstyledButton>
      )}
    </Stack>
  );
}

/** The one-line composer: always visible, type + Enter appends (auto-timestamped by
 *  the server), Escape blurs. Pressing `c` with the card under the pointer jumps
 *  focus here from anywhere non-editable. Appends optimistically — the line shows
 *  immediately and reconciles against the synced insert; on failure the text falls
 *  back into the input rather than vanishing. */
function DiaryComposer({
  taskId,
  setPending,
}: {
  taskId: number;
  setPending: (update: (p: PendingLine[]) => PendingLine[]) => void;
}) {
  const { appendComment } = useStore();
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const comments = useTaskComments(taskId);

  // Reconcile: once a pending line's real row has streamed into the collection,
  // drop the echo — the synced row now renders it.
  const ids = useMemo(() => new Set(comments.map((c) => c.id)), [comments]);
  useEffect(() => {
    setPending((p) => p.filter((x) => x.realId == null || !ids.has(x.realId)));
  }, [ids, setPending]);

  // `c` over the card jumps focus to the composer — capture from anywhere that
  // isn't already an editable target.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "c" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const el = inputRef.current;
      if (!el?.closest("[data-pm-card]")?.matches(":hover")) return;
      e.preventDefault();
      el.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const submit = async () => {
    const body = value.trim();
    if (!body) return;
    const key = ++pendingSeq;
    setPending((p) => [...p, { key, body, at: new Date() }]);
    setValue("");
    const row = await appendComment(taskId, body);
    if (!row) {
      // Failed append: drop the echo and hand the words back to the input.
      setPending((p) => p.filter((x) => x.key !== key));
      setValue((v) => v || body);
      return;
    }
    setPending((p) => p.map((x) => (x.key === key ? { ...x, realId: row.id } : x)));
  };

  return (
    <TextInput
      ref={inputRef}
      size="xs"
      mt="tight"
      variant="filled"
      placeholder="add a line… (c)"
      value={value}
      onChange={(e) => setValue(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") submit();
        else if (e.key === "Escape") e.currentTarget.blur();
      }}
    />
  );
}

/** The diary block a task card renders: timeline + composer, sharing the optimistic
 *  pending lines so an appended line is visible the instant Enter is hit. */
export function TaskDiary({ taskId }: { taskId: number }) {
  const [pending, setPending] = useState<PendingLine[]>([]);
  return (
    <>
      <DiaryTimeline taskId={taskId} pending={pending} />
      <DiaryComposer taskId={taskId} setPending={setPending} />
    </>
  );
}
