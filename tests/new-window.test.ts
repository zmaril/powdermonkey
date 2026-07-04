import { describe, expect, test } from "bun:test";
import { stripPickParam, withPickParam } from "../src/web/new-window.ts";

// The pure seams of the ?pick=1 boot flag: stamping it onto a spawn URL's search
// and consuming it off the address bar. (Opening the scoped picker is store
// surgery, exercised through the app; the Cmd/Ctrl-N chord lives in
// window-bridge / useWindowKeybindings.)

describe("withPickParam", () => {
  test("stamps the flag, preserving existing params", () => {
    expect(withPickParam("")).toBe("?pick=1");
    expect(withPickParam("?theme=abyss")).toBe("?theme=abyss&pick=1");
  });
});

describe("stripPickParam", () => {
  test("removes the flag, keeping any other params", () => {
    expect(stripPickParam("?pick=1")).toBe("");
    expect(stripPickParam("?pick=1&theme=abyss")).toBe("?theme=abyss");
    expect(stripPickParam("")).toBe("");
  });
});
