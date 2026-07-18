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
//   Handshake — on connect the holder writes ONE newline-terminated JSON control
//   line, `{"v":1}\n`, then switches to the binary frame stream. The client reads up
//   to the first `\n`, notes the version, and only then starts reading frames. There
//   is NO role handshake in this protocol version (the reader/writer split is a
//   future disponent milestone); the holder is multi-reader with unrestricted write,
//   so a connected client may both read output and write input.
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
  /** Send raw bytes to the pty master (an Input frame). */
  write(data: string | Uint8Array): void;
  /** Request a pty resize (a Resize frame). */
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
  // `{"v":1}` handshake, then the binary frame stream.
  let buf = new Uint8Array(0);
  let handshakeDone = false;
  let finished = false; // onExit or onClose has fired — don't fire either again

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

  // Consume the leading `{"v":N}\n` handshake line, then hand off to frame parsing.
  const consume = () => {
    if (!handshakeDone) {
      const nl = buf.indexOf(NEWLINE);
      if (nl < 0) return; // handshake line not fully arrived yet
      handshakeDone = true;
      buf = buf.slice(nl + 1);
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

  const send = (frame: Uint8Array) => {
    if (finished) return;
    try {
      socket.write(frame);
    } catch {}
  };

  return {
    write(data: string | Uint8Array) {
      const bytes = typeof data === "string" ? encoder.encode(data) : data;
      send(encodeFrame(CLIENT_INPUT, bytes));
    },
    resize(cols: number, rows: number) {
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
