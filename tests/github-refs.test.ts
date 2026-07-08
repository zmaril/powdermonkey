import { expect, test } from "bun:test";
import type { ILink, Terminal } from "@xterm/xterm";
import { GithubRefLinkProvider } from "../src/web/github-links.ts";
import { findGithubRefs, githubRefUrl } from "../src/web/github-refs.ts";

// The terminal GitHub-ref links have two pure-ish cores: the matcher (findGithubRefs)
// that decides which #123 / owner/repo#123 / GH-123 tokens in a line of PTY text are real
// references, and the provider that maps those tokens back onto buffer cells (across a
// hard wrap) and resolves a bare ref against the terminal's repo context. These pin both.

const refs = (s: string) => findGithubRefs(s);
const tokens = (s: string) => refs(s).map((m) => m.text);

test("matches each reference form", () => {
  expect(refs("merged #66")).toEqual([
    { repo: undefined, number: 66, index: 7, length: 3, text: "#66" },
  ]);
  expect(refs("see zmaril/powdermonkey#71")).toEqual([
    { repo: "zmaril/powdermonkey", number: 71, index: 4, length: 22, text: "zmaril/powdermonkey#71" },
  ]);
  expect(refs("fixed GH-42")).toEqual([
    { repo: undefined, number: 42, index: 6, length: 5, text: "GH-42" },
  ]);
});

test("matches several refs in one line, in order", () => {
  expect(tokens("closes #1 and my-org/my.repo#23 and gh-5")).toEqual([
    "#1",
    "my-org/my.repo#23",
    "gh-5",
  ]);
});

test("GH- mention is case-insensitive on the GH", () => {
  expect(tokens("GH-1 gh-2 Gh-3 gH-4")).toEqual(["GH-1", "gh-2", "Gh-3", "gH-4"]);
});

test("a bare ref carries no repo; a qualified ref carries its slug", () => {
  expect(refs("#9")[0].repo).toBeUndefined();
  expect(refs("a/b#9")[0].repo).toBe("a/b");
});

test("does not fire inside URLs or larger tokens", () => {
  // Full URLs belong to WebLinksAddon — the #fragment and the owner/repo inside are ours
  // to leave alone.
  expect(tokens("https://github.com/zmaril/powdermonkey/pull/66")).toEqual([]);
  expect(tokens("https://github.com/o/r/issues/6#issuecomment-1")).toEqual([]);
  expect(tokens("color #123abc here")).toEqual([]); // hex-ish, no word boundary after digits
  expect(tokens("v1-#3")).toEqual([]); // hyphen before # — part of a larger token
  expect(tokens("nan#12")).toEqual([]); // # glued to a word before it
});

test("owner/repo#n follows GitHub autolink semantics, dots and all", () => {
  // GitHub linkifies any owner/repo#num without knowing your filesystem — a dotted repo
  // name (facebook/react.dev#5) works, and so, unavoidably, does a dotted path written the
  // same way (docs/guide.md#123). We match GitHub rather than guess which is a "real" repo.
  expect(tokens("facebook/react.dev#5")).toEqual(["facebook/react.dev#5"]);
  expect(refs("docs/guide.md#123")[0].repo).toBe("docs/guide.md");
});

test("bounds numbers with a word boundary", () => {
  expect(tokens("#12.")).toEqual(["#12"]); // trailing period
  expect(tokens("(#12)")).toEqual(["#12"]); // brackets
  expect(tokens("#12,#13")).toEqual(["#12", "#13"]);
  expect(tokens("nan#12")).toEqual([]); // # glued to a word before it
});

test("reports the correct index for back-mapping", () => {
  const m = findGithubRefs("landed zmaril/powdermonkey#71 today");
  expect(m).toHaveLength(1);
  const { index, length } = m[0];
  expect("landed zmaril/powdermonkey#71 today".slice(index, index + length)).toBe(
    "zmaril/powdermonkey#71",
  );
});

test("githubRefUrl points at /issues/ (GitHub redirects PRs there)", () => {
  expect(githubRefUrl("zmaril/powdermonkey", 66)).toBe(
    "https://github.com/zmaril/powdermonkey/issues/66",
  );
});

// ---- provider cell mapping + context resolution ------------------------------------

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

/** A fake Terminal exposing just the buffer surface the provider reads. */
function fakeTerm(rows: [string, boolean][], cols: number): Terminal {
  const lines = rows.map(([s, w]) => fakeLine(s, w, cols));
  return {
    buffer: { active: { getLine: (i: number) => lines[i] } },
  } as unknown as Terminal;
}

function linksFor(
  term: Terminal,
  y: number,
  repoSlug: () => string | undefined = () => undefined,
  onActivate: (url: string) => void = () => {},
): ILink[] | undefined {
  const provider = new GithubRefLinkProvider(term, onActivate, repoSlug);
  let result: ILink[] | undefined;
  provider.provideLinks(y, (links) => {
    result = links;
  });
  return result;
}

test("maps a qualified ref to its exact cells and opens its repo", () => {
  const opened: string[] = [];
  const term = fakeTerm([["see a/b#12 ok", false]], 80);
  const links = linksFor(term, 1, () => undefined, (url) => opened.push(url)) ?? [];
  expect(links).toHaveLength(1);
  expect(links[0].text).toBe("a/b#12");
  // "a/b#12" sits at columns 5–10 (1-based) of row 1.
  expect(links[0].range).toEqual({ start: { x: 5, y: 1 }, end: { x: 10, y: 1 } });
  links[0].activate({} as MouseEvent, "a/b#12");
  expect(opened).toEqual(["https://github.com/a/b/issues/12"]);
});

test("resolves a bare ref against the terminal's repo context", () => {
  const opened: string[] = [];
  const term = fakeTerm([["merged #66 now", false]], 80);
  const links =
    linksFor(term, 1, () => "zmaril/powdermonkey", (url) => opened.push(url)) ?? [];
  expect(links).toHaveLength(1);
  links[0].activate({} as MouseEvent, "#66");
  expect(opened).toEqual(["https://github.com/zmaril/powdermonkey/issues/66"]);
});

test("leaves a bare ref unlinked when there's no repo context", () => {
  const term = fakeTerm([["merged #66 now", false]], 80);
  // A qualified ref on the same line still links — only the bare one is dropped.
  const term2 = fakeTerm([["#66 vs a/b#7", false]], 80);
  expect(linksFor(term, 1)).toBeUndefined();
  expect(linksFor(term2, 1)?.map((l) => l.text)).toEqual(["a/b#7"]);
});

test("matches a ref split across a wrapped line", () => {
  // cols = 10: row 0 fills to "see big #1", row 1 wraps with "23 done". "#123" is split
  // across the wrap; the provider still sees one token whose range spans both rows.
  const term = fakeTerm(
    [
      ["see big #1", false],
      ["23 done", true],
    ],
    10,
  );
  const links = linksFor(term, 1, () => "o/r") ?? [];
  expect(links).toHaveLength(1);
  expect(links[0].text).toBe("#123");
  expect(links[0].range.start).toEqual({ x: 9, y: 1 });
  expect(links[0].range.end).toEqual({ x: 2, y: 2 });
});
