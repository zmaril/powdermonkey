// The manager↔worker Message vocabulary shared by the server route and the web UI.
//
// disponent owns Message rows (notes/manager-worker-comms.md) — one is minted per
// recipient of a `send`, all sharing a `fanoutId`; `ack` stamps `ackedAt`. pm reads them
// through a thin proxy route (GET /sessions/:id/messages) for two operator surfaces: the
// fan-out "N of M acked" progress roll-up, and hydrating a worker→manager decision card
// with the real question body (the `mail` event's MailRef carries no body — it lives on
// the Message row). This module carries the wire DTO + the pure ack-progress reducer, with
// NO server/web deps (no @disponent/node, a native addon that can't enter the browser
// bundle), so the route, the renderer, and the unit tests all speak one shape.

/** One Message as pm hands it to the UI: the disponent Party enums (`sender`/`recipient`)
 *  ride as their plain string tokens (`manager`/`worker`/`user`), and disponent's `id` is
 *  surfaced as `messageId` so it lines up with the `mail` event's MailRef.messageId the
 *  card threads a reply against. `topic`/`ackedAt` are null when absent (never undefined,
 *  so the wire shape is stable). Read-only — pm never writes acks. */
export type MessageDto = {
  messageId: string;
  sender: string;
  recipient: string;
  body: string;
  fanoutId: string;
  topic: string | null;
  ackedAt: string | null;
};

/** The disponent Message fields this module reads — a structural subset of
 *  @disponent/node's `Message`, so the mapper stays dependency-free and testable
 *  without opening the native engine. */
type DisponentMessage = {
  id: string;
  sender: string;
  recipient: string;
  body: string;
  fanoutId: string;
  topic?: string | null;
  ackedAt?: string | null;
};

/** Project a disponent Message onto the wire DTO: `id` → `messageId`, and the optional
 *  `topic`/`ackedAt` normalized to null so the UI never has to distinguish absent from
 *  undefined. */
export function messageDto(m: DisponentMessage): MessageDto {
  return {
    messageId: m.id,
    sender: m.sender,
    recipient: m.recipient,
    body: m.body,
    fanoutId: m.fanoutId,
    topic: m.topic ?? null,
    ackedAt: m.ackedAt ?? null,
  };
}

/** Fan-out ack progress: how many of a `fanoutId`'s messages a recipient has
 *  acknowledged (`ackedAt` stamped) over the total minted. Pure — the "N of M acked"
 *  indicator reads this off whatever the route returned. `total` is 0 for an empty read
 *  (no live session / unknown fanout), which the widget treats as "nothing to show". */
export function ackProgress(messages: readonly { ackedAt: string | null }[]): {
  acked: number;
  total: number;
} {
  return {
    acked: messages.reduce((n, m) => n + (m.ackedAt != null ? 1 : 0), 0),
    total: messages.length,
  };
}
