import { Anchor, Group } from "@mantine/core";
import { IconExternalLink } from "@tabler/icons-react";
import type { Task } from "../../server/schema.ts";
import { ReviewLink } from "./ReviewLink.tsx";

// A text link that trails a small external-link icon, kept on one baseline.
const linkStyle = { display: "inline-flex", alignItems: "center", gap: 3 } as const;

export function TaskLinks({ task }: { task: Task }) {
  return (
    <Group gap="md">
      {task.sessionUrl && (
        <Anchor href={task.sessionUrl} target="_blank" size="sm" style={linkStyle}>
          session <IconExternalLink size={13} />
        </Anchor>
      )}
      <ReviewLink task={task} />
      {task.prUrl && (
        <Anchor href={task.prUrl} target="_blank" size="sm" style={linkStyle}>
          PR <IconExternalLink size={13} />
        </Anchor>
      )}
    </Group>
  );
}
