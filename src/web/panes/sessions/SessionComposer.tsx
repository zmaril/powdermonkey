import { Button, Group, Stack, Text, TextInput } from "@mantine/core";
import { IconSend } from "@tabler/icons-react";
import { useState } from "react";
import type { Session } from "../../../server/schema.ts";
import { SessionState } from "../../../shared/types.ts";
import { api } from "../../client.ts";

/** The write half of Slice 4: a one-line composer that sends operator input to a
 *  disponent-managed (Remote) session's live agent (POST /sessions/:id/send → d.send).
 *  disponent HARD-GUARDS on state — a send only lands while the session is running —
 *  so the button is disabled otherwise, with a hint saying why. A non-2xx response
 *  carries disponent's honest bail (e.g. "state is …, not running"), which we surface
 *  inline rather than swallow. The input clears only on success; the sent line echoes
 *  back into the feed as disponent pushes a supervisor `message` event. */
export function SessionComposer({ session }: { session: Session }) {
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const running = session.state === SessionState.Running;

  const submit = async () => {
    const text = input.trim();
    if (!text || sending || !running) return;
    setSending(true);
    setError(null);
    const { error: err } = await api.sessions({ id: session.id }).send.post({ input: text });
    setSending(false);
    if (err) {
      const v = err.value as { error?: string } | undefined;
      setError(v?.error ?? `send failed (${err.status})`);
      return;
    }
    setInput("");
  };

  return (
    <Stack gap="hair">
      <Group gap="tight" wrap="nowrap" align="flex-start">
        <TextInput
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
