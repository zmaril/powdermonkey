import { describe, expect, test } from "bun:test";
import { stripPickParam } from "../src/web/new-window.ts";

// The pure seam of the ?pick=1 boot: consuming the flag off the address bar.
// (Opening the picker is store surgery, exercised through the app; the Cmd/Ctrl-N
// chord itself lives in window-bridge / useWindowKeybindings.)

describe("stripPickParam", () => {
  test("removes the flag, keeping any other params", () => {
    expect(stripPickParam("?pick=1")).toBe("");
    expect(stripPickParam("?pick=1&theme=abyss")).toBe("?theme=abyss");
    expect(stripPickParam("")).toBe("");
  });
});
