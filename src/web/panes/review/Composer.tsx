import { Box, Button, Group, Text, Textarea } from "@mantine/core";
import { useState } from "react";

/** The new-comment composer shown when a line's "+" is clicked. `submitLabel` is
 *  "Add to review" for a fresh line comment (batched) and "Reply" for a thread
 *  reply (posted immediately). */
export function Composer({
  onSubmit,
  onCancel,
  posting,
  submitLabel = "Add to review",
  hint,
}: {
  onSubmit: (body: string) => void | Promise<void>;
  onCancel: () => void;
  posting: boolean;
  submitLabel?: string;
  hint?: string;
}) {
  const [draft, setDraft] = useState("");
  return (
    <Box px="md" py="snug" style={{ background: "var(--pm-surface)" }}>
      {hint && (
        <Text size="xs" c="dimmed" mb="tight">
          {hint}
        </Text>
      )}
      <Textarea
        autosize
        minRows={2}
        size="xs"
        placeholder="Leave a comment on this line…"
        value={draft}
        onChange={(e) => setDraft(e.currentTarget.value)}
        autoFocus
      />
      <Group gap="snug" mt="tight">
        <Button
          size="compact-xs"
          loading={posting}
          disabled={!draft.trim()}
          onClick={() => onSubmit(draft)}
        >
          {submitLabel}
        </Button>
        <Button size="compact-xs" variant="subtle" color="gray" onClick={onCancel}>
          Cancel
        </Button>
      </Group>
    </Box>
  );
}
