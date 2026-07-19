import { Button, Group, Stack, Text, TextInput } from "@mantine/core";
import { IconSend } from "@tabler/icons-react";
import { useCallback, useRef, useState } from "react";
import type { Session } from "../../../server/schema.ts";
import { SessionState } from "../../../shared/types.ts";
import { api } from "../../client.ts";
import { useReplySeed } from "./useReplySeed.ts";

/** A reply the operator chose to draft from a "needs a decision" mail card: the message
 *  id the answer threads against (`inReplyTo`) plus a prefilled body. `token` changes on
 *  every Reply click so the composer re-seeds even when the text is identical — the value
 *  identity, not the body, is what re-fires the seed effect. */
export type ComposerReply = {
  messageId: string;
  body: string;
  token: number;
};

/** The write half of Slice 4: a one-line composer that sends operator input to a
 *  disponent-managed (Remote) session's live agent (POST /sessions/:id/send → d.send).
 *  disponent HARD-GUARDS on state — a send only lands while the session is running —
 *  so the button is disabled otherwise, with a hint saying why. A non-2xx response
 *  carries disponent's honest bail (e.g. "state is …, not running"), which we surface
 *  inline rather than swallow. The input clears only on success; the sent line echoes
 *  back into the feed as disponent pushes a supervisor `message` event.
 *
 *  It is CONTROLLABLE for the escalation flow: an optional `reply` seeds the body and the
 *  `inReplyTo` message id (from a worker's mail card), so answering a worker's question is
 *  a prefilled send back down to that same worker session. Absent `reply`, it behaves
 *  exactly as the original self-contained box. */
export function SessionComposer({
  session,
  reply,
  onReplyConsumed,
}: {
  session: Session;
  reply?: ComposerReply | null;
  onReplyConsumed?: () => void;
}) {
  const [input, setInput] = useState("");
  const [inReplyTo, setInReplyTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const running = session.state === SessionState.Running;
  const ref = useRef<HTMLInputElement>(null);

  // Seed the composer from a Reply click (the effect lives in useReplySeed). Focusing lands
  // the cursor for an inline answer. `seed` is stable (state setters + ref are), so the hook
  // only re-seeds on a genuinely new reply token.
  const seed = useCallback((r: { body: string; messageId: string }) => {
    setInput(r.body);
    setInReplyTo(r.messageId);
    setError(null);
    ref.current?.focus();
  }, []);
  useReplySeed(reply, seed);

  const submit = async () => {
    const text = input.trim();
    if (!text || sending || !running) return;
    setSending(true);
    setError(null);
    const { error: err } = await api
      .sessions({ id: session.id })
      .send.post({ input: text, inReplyTo: inReplyTo ?? undefined });
    setSending(false);
    if (err) {
      const v = err.value as { error?: string } | undefined;
      setError(v?.error ?? `send failed (${err.status})`);
      return;
    }
    setInput("");
    setInReplyTo(null);
    onReplyConsumed?.();
  };

  return (
    <Stack gap="hair">
      {inReplyTo && (
        <Group gap="tight" wrap="nowrap" justify="space-between">
          <Text size="xs" c="grape.4" title={`Replying to message ${inReplyTo}`}>
            Replying to the worker's question
          </Text>
          <Button
            size="compact-xs"
            variant="subtle"
            color="gray"
            onClick={() => {
              setInReplyTo(null);
              setInput("");
              onReplyConsumed?.();
            }}
          >
            Cancel
          </Button>
        </Group>
      )}
      <Group gap="tight" wrap="nowrap" align="flex-start">
        <TextInput
          ref={ref}
          size="xs"
          style={{ flex: 1, minWidth: 0 }}
          placeholder={running ? "Send input to the agent…" : "Sends only work while running"}
          value={input}
          disabled={!running || sending}
          error={error ?? undefined}
          onChange={(e) => {
            setInput(e.currentTarget.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <Button
          size="compact-sm"
          variant="light"
          color="grape"
          leftSection={<IconSend size={13} />}
          loading={sending}
          disabled={!running || input.trim().length === 0}
          title={
            running
              ? "Send input to the running agent"
              : "Sends only work while the session is running"
          }
          onClick={() => void submit()}
        >
          Send
        </Button>
      </Group>
      {!running && (
        <Text size="xs" c="dimmed">
          Input can only be sent while the session is running.
        </Text>
      )}
    </Stack>
  );
}
