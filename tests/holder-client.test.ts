import { expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { connectHolder, type HolderExit } from "../src/server/holder-client.ts";

// Prove the holder-protocol client speaks disponent main's wire format
// byte-for-byte (transcribed from crates/disponent-hold/src/protocol.rs): the
// CLIENT sends a `{"role":"writer"}\n` request first, the holder replies with a
// `{"role":"<granted>","writer_busy":<bool>}\n` line, then `1 byte kind | LE u32
// len | payload` frames flow — server Data(0) / Heartbeat(1) / Exit(2, 5-byte
// disposition+LE i32), client Input(0) / Resize(1, u16 LE cols,rows) / Detach(2).
// The test stands up a fake holder on a unix socket that enforces client-first.

const sock = join(process.env.TMPDIR ?? "/tmp", `pm-holder-test-${process.pid}.sock`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const NEWLINE = 0x0a;

function frame(kind: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  out[0] = kind;
  new DataView(out.buffer).setUint32(1, payload.length, true);
  out.set(payload, 5);
  return out;
}

test("holder client: role handshake, decodes Data/Exit, encodes Input/Resize", async () => {
  try {
    unlinkSync(sock);
  } catch {}

  const received: number[] = []; // raw client→server bytes the fake holder saw
  let roleLineSeen = false; // the client must send its role request first
  // biome-ignore lint/suspicious/noExplicitAny: Bun socket handle isn't worth typing here.
  let conn: any = null;
  const server = Bun.listen({
    unix: sock,
    socket: {
      open(s) {
        conn = s;
      },
      data(s, d: Buffer) {
        for (const b of d) received.push(b);
        // First line is the client's role request; only then does the holder reply
        // with the granted role and start streaming frames.
        if (!roleLineSeen && received.includes(NEWLINE)) {
          roleLineSeen = true;
          s.write(new TextEncoder().encode('{"role":"writer","writer_busy":false}\n'));
          s.write(frame(0, new TextEncoder().encode("hello")));
        }
      },
    },
  });

  const data: Uint8Array[] = [];
  let exit: HolderExit | null = null;
  const client = await connectHolder(sock, {
    onData: (b) => data.push(b),
    onExit: (e) => {
      exit = e;
    },
  });

  await sleep(50);
  // The client sent its `{"role":"writer"}\n` request first (holder saw a newline).
  expect(roleLineSeen).toBe(true);
  // Granted the writer lock — input is live, not dropped.
  expect(client.readOnly).toBe(false);
  // The Data frame decoded to its raw payload (scrollback replay).
  expect(new TextDecoder().decode(data[0])).toBe("hello");

  // The role-request line the client sent, then Input("hi") and Resize(80, 24).
  const roleReq = new TextEncoder().encode('{"role":"writer"}\n');
  client.write("hi");
  client.resize(80, 24);
  await sleep(50);

  // Input frame: kind 0, len 2 (LE u32), payload "hi".
  const input = frame(0, new TextEncoder().encode("hi"));
  // Resize frame: kind 1, len 4, payload u16 LE cols=80 then rows=24.
  const resizePayload = new Uint8Array(4);
  const rv = new DataView(resizePayload.buffer);
  rv.setUint16(0, 80, true);
  rv.setUint16(2, 24, true);
  const resize = frame(1, resizePayload);
  expect(received).toEqual([...roleReq, ...input, ...resize]);

  // Server → client Exit over the live connection: disposition 0 (code) + LE i32 3.
  const exitPayload = new Uint8Array(5);
  new DataView(exitPayload.buffer).setInt32(1, 3, true); // disposition byte stays 0
  conn.write(frame(2, exitPayload));
  await sleep(50);
  expect<HolderExit | null>(exit).toEqual({ kind: "code", value: 3 });

  client.close();
  server.stop();
  try {
    unlinkSync(sock);
  } catch {}
});

test("holder client: Exit with a signal disposition decodes as signal", async () => {
  const sig = 9;
  try {
    unlinkSync(sock);
  } catch {}
  let roleLineSeen = false;
  const server = Bun.listen({
    unix: sock,
    socket: {
      open() {},
      data(s, d: Buffer) {
        if (roleLineSeen || !d.includes(NEWLINE)) return;
        roleLineSeen = true;
        s.write(new TextEncoder().encode('{"role":"writer","writer_busy":false}\n'));
        const payload = new Uint8Array(5);
        payload[0] = 1; // disposition 1 = killed by signal
        new DataView(payload.buffer).setInt32(1, sig, true);
        s.write(frame(2, payload));
      },
    },
  });
  let exit: HolderExit | null = null;
  const client = await connectHolder(sock, {
    onData: () => {},
    onExit: (e) => {
      exit = e;
    },
  });
  await sleep(50);
  expect<HolderExit | null>(exit).toEqual({ kind: "signal", value: sig });
  client.close();
  server.stop();
  try {
    unlinkSync(sock);
  } catch {}
});

test("holder client: writer_busy reply admits us read-only and drops input", async () => {
  try {
    unlinkSync(sock);
  } catch {}
  const received: number[] = [];
  let roleLineSeen = false;
  const server = Bun.listen({
    unix: sock,
    socket: {
      open() {},
      data(s, d: Buffer) {
        for (const b of d) received.push(b);
        if (roleLineSeen || !received.includes(NEWLINE)) return;
        roleLineSeen = true;
        // Another attacher already holds the writer lock: grant reader + busy flag.
        s.write(new TextEncoder().encode('{"role":"reader","writer_busy":true}\n'));
        s.write(frame(0, new TextEncoder().encode("shared output")));
      },
    },
  });

  const data: Uint8Array[] = [];
  let readOnlyFired = false;
  const client = await connectHolder(sock, {
    onData: (b) => data.push(b),
    onExit: () => {},
    onReadOnly: () => {
      readOnlyFired = true;
    },
  });

  await sleep(50);
  // We were admitted read-only; the onReadOnly notice fired and the flag is set.
  expect(client.readOnly).toBe(true);
  expect(readOnlyFired).toBe(true);
  // Data still flows so the browser sees output.
  expect(new TextDecoder().decode(data[0])).toBe("shared output");

  // The role request is the ONLY thing on the wire — write/resize are dropped.
  const roleReq = [...new TextEncoder().encode('{"role":"writer"}\n')];
  client.write("should be dropped");
  client.resize(120, 40);
  await sleep(50);
  expect(received).toEqual(roleReq);

  client.close();
  server.stop();
  try {
    unlinkSync(sock);
  } catch {}
});
