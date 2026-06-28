import { describe, expect, test } from "bun:test";
import { normalizeUrl } from "../src/web/browser-url.ts";

describe("normalizeUrl", () => {
  test("prepends http:// to a bare host:port (the dev-server case)", () => {
    expect(normalizeUrl("localhost:3000")).toBe("http://localhost:3000");
    expect(normalizeUrl("127.0.0.1:5173/preview")).toBe("http://127.0.0.1:5173/preview");
  });

  test("leaves an explicit scheme untouched", () => {
    expect(normalizeUrl("http://localhost:3000")).toBe("http://localhost:3000");
    expect(normalizeUrl("https://example.com/path")).toBe("https://example.com/path");
  });

  test("does not treat a bare host:port as a scheme", () => {
    // `localhost:3000` has a colon but no `://` — the host must not be read as a scheme.
    expect(normalizeUrl("localhost:3000")).not.toBe("localhost:3000");
  });

  test("trims surrounding whitespace", () => {
    expect(normalizeUrl("  localhost:3000  ")).toBe("http://localhost:3000");
    expect(normalizeUrl("  https://example.com  ")).toBe("https://example.com");
  });

  test("empty / whitespace-only normalizes to empty", () => {
    expect(normalizeUrl("")).toBe("");
    expect(normalizeUrl("   ")).toBe("");
  });
});
