import { expect, test } from "bun:test";
import type { ILink, Terminal } from "@xterm/xterm";
import { PmIdLinkProvider } from "../src/web/pm-id-links.ts";
import { findPmIds } from "../src/web/pm-ids.ts";
import type { PmKind } from "../src/web/pm-ids.ts";

// The terminal PM-id links have two pure-ish cores: the matcher (findPmIds) that decides
// which t/p/m/g/s tokens in a line of PTY text are real plan references, and the provider
// that maps those tokens back onto buffer cells (including across a hard wrap). These pin
// both — the robustness rules especially: word boundaries, and never linking inside a
// URL / path / filename.

const tokens = (s: string) => findPmIds(s).map((m) => m.text);

test("matches each entity kind as a standalone token", () => {
  expect(findPmIds("landed t110")).toEqual([
    { kind: "t", id: 110, index: 7, length: 4, text: "t110" },
  ]);
  expect(tokens("g1 m6 t110 p41 s5")).toEqual(["g1", "m6", "t110", "p41", "s5"]);
});

test("only matches on real word boundaries", () => {
  expect(tokens("part3")).toEqual([]); // t3 mid-word
  expect(tokens("svg5")).toEqual([]); // g5 mid-word
  expect(tokens("at3")).toEqual([]); // t3 with a letter before
  expect(tokens("t3a")).toEqual([]); // t3 with a letter after
  expect(tokens("gpt3")).toEqual([]); // no boundary before t, g not followed by a digit
});

test("matches around punctuation and brackets", () => {
  expect(tokens("see t12.")).toEqual(["t12"]); // sentence-ending period
  expect(tokens("(g3)")).toEqual(["g3"]);
  expect(tokens("t12,t13")).toEqual(["t12", "t13"]);
});

test("uppercase prefixes are not ids", () => {
  expect(tokens("T12 G3")).toEqual([]);
});

test("does not match ids inside URLs, paths, or filenames", () => {
  expect(tokens("https://example.com/t12")).toEqual([]);
  expect(tokens("src/web/t41.ts")).toEqual([]);
  expect(tokens("t41.ts")).toEqual([]);
  expect(tokens("C:\\plans\\t9")).toEqual([]);
  // …but a real id alongside a URL still matches.
  expect(tokens("open http://x/t9 then land t5")).toEqual(["t5"]);
});

test("reports the correct index for back-mapping", () => {
  const m = findPmIds("blocked on p41 now");
  expect(m).toHaveLength(1);
  expect(m[0].index).toBe(11);
  expect("blocked on p41 now".slice(m[0].index, m[0].index + m[0].length)).toBe("p41");
});

// ---- provider cell mapping ----------------------------------------------------------

/** A fake buffer line backed by a plain string, padded to `cols` with blanks so wrapped
 *  rows have the same shape xterm gives them. */
function fakeLine(s: string, isWrapped: boolean, cols: number) {
  const padded = s.padEnd(cols, " ");
  return {
    length: cols,
    isWrapped,
    getCell(i: number) {
      const ch = padded[i] ?? " ";
      return { getWidth: () => 1, getChars: () => (ch === " " ? "" : ch) };
    },
  };
}

/** A fake Terminal exposing just the buffer surface the provider reads. `rows` are
 *  [text, isWrapped] pairs; row 0 is buffer line index 0. */
function fakeTerm(rows: [string, boolean][], cols: number): Terminal {
  const lines = rows.map(([s, w]) => fakeLine(s, w, cols));
  return {
    buffer: { active: { getLine: (i: number) => lines[i] } },
  } as unknown as Terminal;
}

function linksFor(
  term: Terminal,
  y: number,
  onActivate: (kind: PmKind, id: number) => void = () => {},
): ILink[] | undefined {
  const provider = new PmIdLinkProvider(term, onActivate);
  let result: ILink[] | undefined;
  provider.provideLinks(y, (links) => {
    result = links;
  });
  return result;
}

test("maps a token to its exact cells on a single row", () => {
  const clicks: Array<[PmKind, number]> = [];
  const term = fakeTerm([["landed t110 ok", false]], 80);
  const links = linksFor(term, 1, (kind, id) => clicks.push([kind, id]));
  expect(links).toHaveLength(1);
  const link = (links ?? [])[0];
  expect(link.text).toBe("t110");
  // "t110" sits at columns 8–11 (1-based) of row 1.
  expect(link.range).toEqual({ start: { x: 8, y: 1 }, end: { x: 11, y: 1 } });
  link.activate({} as MouseEvent, "t110");
  expect(clicks).toEqual([["t", 110]]);
});

test("matches a token split across a wrapped line", () => {
  // cols = 10: row 0 fills to "see big t1", row 1 wraps with "23 done". The id "t123" is
  // split across the wrap; the provider should still see it as one token whose range
  // spans both rows.
  const term = fakeTerm(
    [
      ["see big t1", false],
      ["23 done", true],
    ],
    10,
  );
  const links = linksFor(term, 1) ?? [];
  expect(links).toHaveLength(1);
  expect(links[0].text).toBe("t123");
  // "t" is the last cell of row 1 (col 9, after "see big " = 8 chars), "123" continues
  // at the start of row 2.
  expect(links[0].range.start).toEqual({ x: 9, y: 1 });
  expect(links[0].range.end).toEqual({ x: 2, y: 2 });
});

test("returns the same wrapped link when queried from the continuation row", () => {
  const term = fakeTerm(
    [
      ["see big t1", false],
      ["23 done", true],
    ],
    10,
  );
  const links = linksFor(term, 2) ?? []; // hovering the second row
  expect(links).toHaveLength(1);
  expect(links[0].text).toBe("t123");
});
