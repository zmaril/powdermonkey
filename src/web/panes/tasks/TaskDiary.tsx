import { Group, Stack, Text, TextInput, UnstyledButton } from "@mantine/core";
import { useRef, useState } from "react";
import { useStore } from "../../store.ts";
import { timeAgo } from "../../time.ts";
import { DiaryLine } from "./DiaryLine.tsx";
import { useComposerJumpKey, usePendingLines, useTaskComments } from "./useDiary.ts";

// The task's diary: its comments rendered chronologically, compact and unobtrusive
// under the phase list, with a zero-ceremony one-line composer below — type + Enter
// appends, auto-timestamped, no modal / title / fields. A long diary collapses to
// its newest lines behind an "earlier" toggle. A line stays an ordinary row after
// capture: click its text to edit in place, × archives it (the soft delete
// everything else uses). Deliberately no formatting and no required fields:
// muttering, not documenting.

/** Above this many lines the diary collapses to the newest TAIL. */
const COLLAPSE_ABOVE = 4;
const TAIL = 3;

/** The diary block a task card renders: the timeline (collapsible, with optimistic
 *  echoes at the bottom) and the always-visible one-line composer. Appends show the
 *  instant Enter is hit and reconcile against the synced insert; a failed append
 *  hands the words back to the input. */
export function TaskDiary({ taskId }: { taskId: number }) {
  const comments = useTaskComments(taskId);
  const { appendComment, updateComment, archiveComment } = useStore();
  const { pending, track, settle, drop } = usePendingLines(comments);
  const [expanded, setExpanded] = useState(false);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useComposerJumpKey(inputRef);

  const collapsed = !expanded && comments.length > COLLAPSE_ABOVE;
  const shown = collapsed ? comments.slice(-TAIL) : comments;
  const hidden = comments.length - shown.length;

  const submit = async () => {
    const body = value.trim();
    if (!body) return;
    const key = track(body);
    setValue("");
    const row = await appendComment(taskId, body);
    if (!row) {
      // Failed append: drop the echo and hand the words back to the input.
      drop(key);
      setValue((v) => v || body);
      return;
    }
    settle(key, row.id);
  };

  return (
    <>
      {(comments.length > 0 || pending.length > 0) && (
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
      )}
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
    </>
  );
}
