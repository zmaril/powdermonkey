// A TypeScript client for the disponent pty-holder's framed attach protocol.
//
// disponent (github.com/zmaril/disponent) ships a first-party headless pty holder
// (`disponent hold <uid> -- <argv>`): it opens a pty, execs the agent under it, and
// serves that byte-exact stream to N attach clients over a unix socket. When the
// local backend runs with the holder path selected (DISPONENT_LOCAL_HOLDER), each
// session's agent lives under such a holder instead of a tmux session.
//
// This client lets pm's `/pty` WebSocket dial that holder socket directly and speak
// its protocol — one dependency fewer on the terminal path than shelling out to
// `tmux attach`. The wire format is transcribed verbatim from disponent's
// `crates/disponent-hold/src/protocol.rs` (read, not guessed):
//
//   Handshake (roles, N-readers-1-writer) — the CLIENT speaks first: on connect it
//   writes ONE newline-terminated JSON control line declaring its role,
//   `{"role":"writer"}\n` (or `"reader"`). The holder replies with ONE
//   newline-terminated line, `{"role":"<granted>","writer_busy":<bool>}\n`: the role
//   it actually GRANTED and whether a writer request was denied because one is
//   already held. At most one writer at a time; N readers. pm's terminal is
//   interactive, so we request `writer`; if the holder answers `writer_busy:true`
//   we were admitted read-only (another attacher drives) — we still stream Data so
//   the browser shows output, but our Input/Resize frames are dropped. Both sides
//   switch to the binary frame stream after the two handshake lines. (This is
//   disponent main's M2a protocol; there is NO `{"v":N}` version field — it was
//   removed when the role handshake landed.)
//
//   Frames — `1 byte kind | 4-byte LE u32 len | len bytes payload`. `len` may be 0.
//   The two directions reuse the small kind space but mean different things:
//     server→client: 0 = Data (raw pty bytes), 1 = Heartbeat (empty, periodic),
//                    2 = Exit (5-byte payload: 1 disposition byte + LE i32 value;
//                              disposition 0 = exit code, 1 = signal number).
//     client→server: 0 = Input (raw bytes → pty), 1 = Resize (u16 LE cols, u16 LE
//                    rows), 2 = Detach (empty), 3 = Signal (LE i32 → child group).
//
// Byte layout is handled through DataView (LE) — the repo's biome config forbids
// bitwise operators, and DataView reads/writes little-endian without them.

/** How a held child ended, decoded from an Exit frame's 5-byte payload. */
export type HolderExit = { kind: "code" | "signal"; value: number };

/** The handles a consumer drives a live holder attach through. */
export type HolderClient = {
  /** True iff the holder admitted us read-only because another attacher holds the
   *  single writer lock (`writer_busy`). While set, {@link write} and
   *  {@link resize} are silent no-ops — the browser keeps seeing output but can't
   *  drive the pty until the writer detaches. */
  readonly readOnly: boolean;
  /** Send raw bytes to the pty master (an Input frame). Dropped when
   *  {@link readOnly} (we hold no writer lock). */
  write(data: string | Uint8Array): void;
  /** Request a pty resize (a Resize frame). Dropped when {@link readOnly}. */
  resize(cols: number, rows: number): void;
  /** Detach cleanly (a Detach frame, then close the socket). The held session and
   *  its agent keep running — this only drops our view. */
  close(): void;
};

export type HolderHandlers = {
  /** Raw pty bytes from a Data frame. */
  onData(bytes: Uint8Array): void;
  /** The held child exited; the attach is over. Fires at most once. */
  onExit(exit: HolderExit): void;
  /** The socket errored or closed before an Exit frame (holder gone). Fires at
   *  most once, and never after onExit. */
  onClose?(err?: Error): void;
  /** The holder admitted us read-only (`writer_busy`) — another attacher holds the
   *  writer lock. Fires at most once, during connect, before any frame. Optional:
   *  a consumer can surface a notice; input is dropped regardless. */
  onReadOnly?(): void;
};

// Server→client frame kinds (protocol.rs `ServerKind`).
const SERVER_DATA = 0;
const SERVER_HEARTBEAT = 1;
const SERVER_EXIT = 2;

// Client→server frame kinds (protocol.rs `ClientKind`).
const CLIENT_INPUT = 0;
const CLIENT_RESIZE = 1;
const CLIENT_DETACH = 2;

const HEADER_LEN = 5; // 1 kind byte + 4 length bytes
const MAX_PAYLOAD = 16 * 1024; // protocol.rs MAX_PAYLOAD — a sanity bound on `len`
const NEWLINE = 0x0a;

/** Encode a client frame: `kind | LE u32 len | payload`. */
function encodeFrame(kind: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(HEADER_LEN + payload.length);
  out[0] = kind;
  new DataView(out.buffer).setUint32(1, payload.length, true);
  out.set(payload, HEADER_LEN);
  return out;
}

/** Encode a Resize frame's payload: u16 LE cols then u16 LE rows. */
function encodeResizePayload(cols: number, rows: number): Uint8Array {
  const p = new Uint8Array(4);
  const dv = new DataView(p.buffer);
  dv.setUint16(0, cols, true);
  dv.setUint16(2, rows, true);
  return p;
}

/** Dial a holder socket and stream its pty. Resolves once the handshake is read and
 *  frames are flowing; rejects if the socket can't be opened. `handlers.onData`
 *  receives live pty bytes (scrollback is replayed first by the holder), `onExit`
 *  fires when the child ends, `onClose` when the holder vanishes without an exit. */
export async function connectHolder(
  socketPath: string,
  handlers: HolderHandlers,
): Promise<HolderClient> {
  // Incoming byte accumulator + a small parse state machine: first the one-line
  // `{"role":...,"writer_busy":...}` handshake reply, then the binary frame stream.
  let buf = new Uint8Array(0);
  let handshakeDone = false;
  let finished = false; // onExit or onClose has fired — don't fire either again
  // Set from the holder's handshake reply: true iff we asked for the writer lock
  // but were admitted read-only because another attacher already holds it.
  let readOnly = false;

  const encoder = new TextEncoder();

  const append = (chunk: Uint8Array) => {
    const next = new Uint8Array(buf.length + chunk.length);
    next.set(buf, 0);
    next.set(chunk, buf.length);
    buf = next;
  };

  const finish = (exit?: HolderExit, err?: Error) => {
    if (finished) return;
    finished = true;
    if (exit) handlers.onExit(exit);
    else handlers.onClose?.(err);
  };

  // Parse as many complete frames as `buf` holds, dispatching each. Returns when it
  // needs more bytes (a partial header/payload) or the stream has finished.
  const drainFrames = () => {
    for (;;) {
      if (finished) return;
      if (buf.length < HEADER_LEN) return;
      const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      const kind = buf[0];
      const len = dv.getUint32(1, true);
      if (len > MAX_PAYLOAD) {
        // A length past the protocol cap means the stream is corrupt; bail rather
        // than allocate wildly.
        finish(undefined, new Error(`holder frame length ${len} exceeds cap`));
        return;
      }
      if (buf.length < HEADER_LEN + len) return; // wait for the rest of the payload
      const payload = buf.slice(HEADER_LEN, HEADER_LEN + len);
      buf = buf.slice(HEADER_LEN + len);
      if (kind === SERVER_DATA) {
        handlers.onData(payload);
      } else if (kind === SERVER_HEARTBEAT) {
        // Empty keepalive — ignore.
      } else if (kind === SERVER_EXIT) {
        // 5-byte payload: 1 disposition byte + LE i32 value.
        if (payload.length === 5) {
          const value = new DataView(payload.buffer, payload.byteOffset, 5).getInt32(1, true);
          finish({ kind: payload[0] === 1 ? "signal" : "code", value });
        } else {
          finish({ kind: "code", value: -1 });
        }
        return;
      }
      // An unknown kind is skipped (forward-compatible with additive server kinds).
    }
  };

  // Consume the leading `{"role":...,"writer_busy":...}\n` handshake reply line —
  // the holder's answer to the role request we sent on connect — then hand off to
  // frame parsing. A missing/unknown role or `writer_busy:true` means we were not
  // granted the writer lock, so we stay read-only.
  const consume = () => {
    if (!handshakeDone) {
      const nl = buf.indexOf(NEWLINE);
      if (nl < 0) return; // handshake reply line not fully arrived yet
      const line = new TextDecoder().decode(buf.slice(0, nl));
      handshakeDone = true;
      buf = buf.slice(nl + 1);
      // The holder echoes the role it GRANTED plus a writer_busy flag. We only ever
      // request "writer"; anything other than a granted writer leaves us read-only.
      const grantedWriter = /"role"\s*:\s*"writer"/.test(line);
      const writerBusy = /"writer_busy"\s*:\s*true/.test(line);
      if (!grantedWriter || writerBusy) {
        readOnly = true;
        handlers.onReadOnly?.();
      }
    }
    drainFrames();
  };

  const socket = await Bun.connect({
    unix: socketPath,
    socket: {
      data(_s, chunk: Buffer) {
        append(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        consume();
      },
      close() {
        finish();
      },
      error(_s, err: Error) {
        finish(undefined, err);
      },
    },
  });

  // The client speaks first: declare our role before any frame. pm's terminal is
  // interactive, so we request the single writer lock; the holder's reply (parsed
  // in `consume`) tells us whether we actually got it.
  socket.write(encoder.encode('{"role":"writer"}\n'));

  const send = (frame: Uint8Array) => {
    if (finished) return;
    try {
      socket.write(frame);
    } catch {}
  };

  return {
    get readOnly() {
      return readOnly;
    },
    write(data: string | Uint8Array) {
      // Read-only attach (another attacher holds the writer lock): drop input so
      // the pty is driven by exactly one writer at a time.
      if (readOnly) return;
      const bytes = typeof data === "string" ? encoder.encode(data) : data;
      send(encodeFrame(CLIENT_INPUT, bytes));
    },
    resize(cols: number, rows: number) {
      if (readOnly) return; // reader resizes are ignored by the holder anyway
      send(encodeFrame(CLIENT_RESIZE, encodeResizePayload(cols, rows)));
    },
    close() {
      // Best-effort Detach, then drop the socket. The holder keeps the session
      // alive; we're only leaving.
      send(encodeFrame(CLIENT_DETACH, new Uint8Array(0)));
      try {
        socket.end();
      } catch {}
    },
  };
}
