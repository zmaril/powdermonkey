import { useEffect, useState } from "react";
import type { MessageDto } from "../../../shared/messages.ts";
import { api } from "../../client.ts";

// Poll a fan-out's Messages off the read-only proxy route (GET /sessions/:id/messages)
// for the decision card: it hydrates the real question body (the `mail` event's MailRef
// carries none) and rolls up "N of M acked" progress as workers acknowledge. Not a synced
// collection — disponent owns these rows, no pm table mirrors them — so the card polls on
// an interval, mirroring usePolled's mount/cleanup dance but parameterized per card.

/** Refresh cadence: acks trickle in as workers act, so a modest poll keeps the
 *  progress live without hammering the engine. */
const POLL_MS = 5_000;

/** Poll the Messages of `fanoutId` for `sessionId`, returning the latest list (empty until
 *  the first response, and left in place on a failed/blank fetch rather than blanking).
 *  A no-op returning `[]` when `fanoutId` is empty — a mail row that inlined no fanout has
 *  nothing to roll up. */
export function useSessionMessages(sessionId: number, fanoutId: string): MessageDto[] {
  const [messages, setMessages] = useState<MessageDto[]>([]);

  useEffect(() => {
    if (!fanoutId) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    const load = async () => {
      const { data } = await api.sessions({ id: sessionId }).messages.get({ query: { fanoutId } });
      const rows = (data as { messages?: MessageDto[] } | null)?.messages;
      if (!cancelled && rows) setMessages(rows);
    };
    load();
    const id = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [sessionId, fanoutId]);

  return messages;
}
