import { Box, Group, Text, Tooltip, UnstyledButton } from "@mantine/core";
import { IconRobot } from "@tabler/icons-react";
import type { TaskComment } from "../../../server/schema.ts";
import { CommentAuthor } from "../../../shared/types.ts";
import { EditableText } from "../../plan-ui";
import { exactTime, timeAgo } from "../../time.ts";

/** True when a line has been edited since it was written (worth a subtle mark). */
const wasEdited = (c: TaskComment) =>
  new Date(c.updatedAt).getTime() - new Date(c.createdAt).getTime() > 1000;

/** One diary line: (supervisor glyph ·) click-to-edit body · relative stamp with the
 *  exact moment on hover · archive ×. Supervisor lines carry the violet robot, the
 *  same voice-coding the phase list uses for supervisor override calls. */
export function DiaryLine({
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
