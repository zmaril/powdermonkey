import { expect, test } from "bun:test";

// Isolate the tmux socket so nothing here touches the operator's real
// `powdermonkey` server (the helper lists/kills sessions on whatever socket it
// reads at import). A unique name per test process keeps parallel suites apart.
process.env.PM_TMUX_SOCKET = `pm-test-${process.pid}`;

const { attachCommand, attach, DEFAULT_TARGET } = await import("../src/server/attach.ts");

test("attachCommand targets the private socket and the given session", () => {
  expect(attachCommand("pm-server")).toBe(
    `tmux -L ${process.env.PM_TMUX_SOCKET} attach -t pm-server`,
  );
  // Defaults to the supervisor server console.
  expect(attachCommand()).toBe(attachCommand(DEFAULT_TARGET));
  expect(DEFAULT_TARGET).toBe("pm-server");
});

test("attach refuses (exit 1) when the target session isn't live", () => {
  // Nothing is running on this throwaway socket, so there's nothing to attach to.
  expect(attach("pm-server")).toBe(1);
});
