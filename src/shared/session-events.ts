// The live-feed vocabulary for a disponent-managed (Remote) session's timeline.
//
// disponent emits a string-kinded event stream (@disponent/node's EventKind); the
// server drains it, validates each kind against one of the STRING constants below, and
// persists the row into `session_events` (see disponent-feed.ts). Everything past the
// server boundary — the DB column, the synced collection, the web renderer — speaks
// these strings, so this module carries NO server/web deps (no @disponent/node, which
// is a native addon and can't enter the browser bundle) and is safe to import from
// the server, the web bundle, and the unit tests alike.

// `(typeof X)[keyof typeof X]` collapses a const object to the union of its values —
// the same idiom shared/types.ts uses, inlined here so this file stays dependency-free.
type ValueOf<T> = T[keyof T];

/** The string kind stored in `session_events.kind`, one per disponent EventKind.
 *  Usage is drained by a SEPARATE path (disponent-usage.ts) and never lands here,
 *  but the constant exists so the numeric→string map below is total. */
export const SESSION_EVENT_KIND = {
  State: "state",
  Message: "message",
  ToolCall: "tool_call",
  ToolResult: "tool_result",
  Log: "log",
  Usage: "usage",
  Artifact: "artifact",
  Mail: "mail",
  Raw: "raw",
} as const;
export type SessionEventKind = ValueOf<typeof SESSION_EVENT_KIND>;

/** The string fidelity stored in `session_events.fidelity`, one per disponent
 *  Fidelity. Kept honest — a scraped terminal frame is marked as such, never as exact. */
export const SESSION_EVENT_FIDELITY = {
  Exact: "exact",
  Derived: "derived",
  Scraped: "scraped",
} as const;
export type SessionEventFidelity = ValueOf<typeof SESSION_EVENT_FIDELITY>;

/** A compact display descriptor for one feed row — the single source of truth the web
 *  renderer (SessionEventFeed) uses so no display logic lives in the component. `icon`
 *  is a short glyph, `label` a one-word kind tag, `text` the human line, and `mono`
 *  asks for a monospace block (set only for a scraped terminal frame). */
export type SessionEventDescriptor = {
  icon: string;
  label: string;
  text: string;
  mono: boolean;
};

/** Coerce the persisted payload (a JSON string, or an already-parsed object) to a
 *  record, returning null when it's malformed — so callers fall back gracefully
 *  instead of throwing on a garbled frame. */
function parsePayload(payload: string | object): Record<string, unknown> | null {
  if (typeof payload !== "string") return payload as Record<string, unknown>;
  try {
    const v = JSON.parse(payload);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const str = (v: unknown): string => (v == null ? "" : String(v));

/** Describe one session-event row for display — PURE and dependency-free, so it's
 *  unit-testable and shared by the server and the web renderer. Parses the payload
 *  per kind into an { icon, label, text, mono } descriptor; NEVER throws — a
 *  malformed payload falls back to the raw JSON string. `mono` is set only for a
 *  scraped terminal frame (a raw event whose source is "terminal"). */
export function describeSessionEvent(row: {
  kind: string;
  payload: string | object;
  fidelity?: string | null;
}): SessionEventDescriptor {
  const p = parsePayload(row.payload);
  // A payload we couldn't parse: hand back the raw string rather than throwing.
  const raw = typeof row.payload === "string" ? row.payload : JSON.stringify(row.payload);
  if (p === null) {
    return { icon: "•", label: row.kind, text: raw, mono: false };
  }

  // Icons are text-presentation glyphs (not emoji) so the source stays plain — the
  // renderer shows them verbatim next to each row.
  switch (row.kind) {
    case SESSION_EVENT_KIND.Message: {
      const role = str(p.role) || "message";
      return { icon: "»", label: role, text: str(p.text), mono: false };
    }
    case SESSION_EVENT_KIND.ToolCall: {
      const tool = str(p.tool) || "tool";
      const input = p.input == null ? "" : ` ${JSON.stringify(p.input)}`;
      return { icon: "$", label: "tool", text: `${tool}${input}`, mono: false };
    }
    case SESSION_EVENT_KIND.ToolResult: {
      const ok = p.ok !== false;
      const tool = str(p.tool) || "tool";
      const output = p.output == null ? "" : ` — ${str(p.output)}`;
      return { icon: ok ? "✓" : "✗", label: tool, text: `${tool}${output}`, mono: false };
    }
    case SESSION_EVENT_KIND.Log:
      return { icon: "·", label: "log", text: str(p.line), mono: false };
    case SESSION_EVENT_KIND.Raw: {
      const source = str(p.source);
      const terminal = source === "terminal";
      return {
        icon: terminal ? ">" : "·",
        label: source || "raw",
        text: str(p.data),
        mono: terminal,
      };
    }
    case SESSION_EVENT_KIND.State:
      return { icon: "◆", label: "state", text: `${str(p.from)} → ${str(p.to)}`, mono: false };
    case SESSION_EVENT_KIND.Artifact:
      return { icon: "◇", label: "artifact", text: raw, mono: false };
    case SESSION_EVENT_KIND.Mail: {
      // A `mail` event carries a MailRef (sender/recipient/messageId/fanoutId/topic) —
      // the Message body itself lives on the disponent Message row, not the ref, so the
      // line summarizes the direction and (when present) the topic. The feed lifts this
      // same payload into a "needs a decision" card for a worker→manager question.
      const sender = str(p.sender) || "?";
      const recipient = str(p.recipient) || "?";
      const topic = str(p.topic);
      const body = str(p.body);
      const text = body || (topic ? `topic: ${topic}` : "message");
      return { icon: "@", label: `${sender}→${recipient}`, text, mono: false };
    }
    default:
      return { icon: "•", label: row.kind, text: raw, mono: false };
  }
}

/** The manager-facing view of a `mail` event's MailRef payload: who sent it, to whom,
 *  the message id a reply threads against (`inReplyTo`), and the optional topic/body.
 *  `body` is not part of the MailRef on the wire (it lives on the disponent Message row),
 *  so it's only populated when a payload happens to inline it — the card degrades to the
 *  topic otherwise. PURE and browser-safe; returns null for a non-mail or garbled row. */
export type MailInfo = {
  messageId: string;
  sender: string;
  recipient: string;
  topic: string;
  body: string;
  // The fan-out this question belongs to (a MailRef always carries one — a single
  // recipient still mints a fanoutId). The card reads Messages by this id to hydrate the
  // real question body (the ref inlines none) AND to roll up "N of M acked" progress.
  fanoutId: string;
};

/** Parse a `mail` row into its MailInfo, or null when the row isn't a mail event or the
 *  payload is malformed — so the feed can branch a worker→manager question into a
 *  "needs a decision" card while leaving every other row on the uniform render. */
export function parseMailEvent(row: { kind: string; payload: string | object }): MailInfo | null {
  if (row.kind !== SESSION_EVENT_KIND.Mail) return null;
  const p = parsePayload(row.payload);
  if (p === null) return null;
  return {
    messageId: str(p.messageId),
    sender: str(p.sender),
    recipient: str(p.recipient),
    topic: str(p.topic),
    body: str(p.body),
    fanoutId: str(p.fanoutId),
  };
}

/** The disponent Party token an inbound worker question is sent BY — a mail row whose
 *  sender is this reads as a decision the manager owes the worker. */
export const MAIL_SENDER_WORKER = "worker";

/** The persisted kinds/fidelities as lookup sets. disponent's EventKind and Fidelity
 *  tokens are the SAME strings as the constants above, so mapping a drained event is a
 *  validated pass-through. Held here (rather than importing @disponent/node, a native
 *  addon that can't enter the browser bundle) so this module stays browser-safe. */
const KNOWN_KINDS: ReadonlySet<string> = new Set(Object.values(SESSION_EVENT_KIND));
const KNOWN_FIDELITIES: ReadonlySet<string> = new Set(Object.values(SESSION_EVENT_FIDELITY));

/** Coerce a disponent EventKind token to its persisted SessionEventKind. Falls back to
 *  "raw" for an unknown (newer engine) kind rather than dropping the event. */
export function sessionEventKind(kind: string): SessionEventKind {
  return KNOWN_KINDS.has(kind) ? (kind as SessionEventKind) : SESSION_EVENT_KIND.Raw;
}

/** Coerce a disponent Fidelity token to its persisted SessionEventFidelity, or null when
 *  absent or unknown. */
export function sessionEventFidelity(
  fidelity: string | null | undefined,
): SessionEventFidelity | null {
  return fidelity != null && KNOWN_FIDELITIES.has(fidelity)
    ? (fidelity as SessionEventFidelity)
    : null;
}
