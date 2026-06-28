import { Badge, Box, Button, Group, Text, Textarea } from "@mantine/core";
import { useState } from "react";
import type { ReviewEvent } from "../../../server/pr-review.ts";
import type { DraftComment } from "./types.ts";

/** The sticky footer that submits the whole pending review at once — a summary plus
 *  Approve / Request changes / Comment. One GitHub review, so a watching session
 *  sees a single event instead of one per comment. */
export function ReviewBar({
  draft,
  summary,
  setSummary,
  submit,
  submitting,
}: {
  draft: DraftComment[];
  summary: string;
  setSummary: (s: string) => void;
  submit: (event: ReviewEvent) => Promise<void>;
  submitting: boolean;
}) {
  const [open, setOpen] = useState(false);
  const n = draft.length;
  return (
    <Box style={{ flex: "0 0 auto", borderTop: "1px solid #2c2e33", background: "#202225" }}>
      <Group justify="space-between" px="md" py={8} wrap="nowrap">
        <Text size="xs" c="dimmed">
          {n === 0 ? "No pending comments" : `${n} pending comment${n === 1 ? "" : "s"}`}
        </Text>
        <Button
          size="xs"
          variant={open ? "light" : "filled"}
          color="blue"
          onClick={() => setOpen((o) => !o)}
          rightSection={
            n > 0 ? (
              <Badge size="xs" circle variant="white" color="blue">
                {n}
              </Badge>
            ) : undefined
          }
        >
          {open ? "Hide review" : "Finish review"}
        </Button>
      </Group>
      {open && (
        <Box px="md" pb={8}>
          <Textarea
            autosize
            minRows={2}
            size="xs"
            placeholder="Review summary (required to request changes)…"
            value={summary}
            onChange={(e) => setSummary(e.currentTarget.value)}
          />
          <Group gap={6} mt={6}>
            <Button
              size="compact-xs"
              color="green"
              loading={submitting}
              onClick={() => submit("APPROVE")}
            >
              Approve
            </Button>
            <Button
              size="compact-xs"
              color="red"
              variant="light"
              loading={submitting}
              onClick={() => submit("REQUEST_CHANGES")}
            >
              Request changes
            </Button>
            <Button
              size="compact-xs"
              variant="light"
              color="blue"
              loading={submitting}
              onClick={() => submit("COMMENT")}
            >
              Comment
            </Button>
          </Group>
        </Box>
      )}
    </Box>
  );
}
