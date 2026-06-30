// PM entity id tokens in free text — the `t/p/m/g/s` + digits chips the operator
// sees everywhere in the UI (see IdTag). Agents and the supervisor print these same
// ids all over their PTY output ("landed t110", "blocked on p41", …), so the terminal
// link provider (pm-id-links.ts) turns them into clickable jumps — the PM-id
// counterpart to the URL links the WebLinksAddon already renders. This module is the
// pure matcher (no xterm, no DOM) so the matching rules stay unit-testable on their own.

/** The five linkable entity kinds, keyed by the single-letter id prefix. */
export type PmKind = "g" | "m" | "t" | "p" | "s";

export type PmIdMatch = {
  kind: PmKind;
  id: number;
  /** 0-based index of the token's first char within the input string. */
  index: number;
  /** Length of the matched token in chars (e.g. "t110" → 4). */
  length: number;
  text: string;
};

// One id token: a g/m/t/p/s prefix immediately followed by digits, bounded by a real
// word boundary on both sides (`\b`) so it never fires mid-word — the "t3" inside
// "part3", the "g5" inside "svg5", and so on are left alone.
const ID_TOKEN = /\b([gmtps])(\d+)\b/g;

// A whitespace-delimited chunk of the line — we match within a chunk, never across the
// whitespace that separates words.
const CHUNK = /\S+/g;

// A chunk that looks like a URL, filesystem path, or filename — a slash/backslash, a
// scheme (`http://`), or a `name.ext` dot. We skip these wholesale so an id buried in
// one ("src/web/t41.ts", "https://x/t9", "t41.ts") is never linked: those aren't plan
// references, and turning them into jumps would be wrong.
const PATH_LIKE = /[/\\]|\w\.\w/;

/** Find every standalone PM id token in `text`, in order, skipping any that sit inside a
 *  URL / path / filename. Pure — the link provider maps each match's `index`/`length`
 *  back onto terminal buffer cells. */
export function findPmIds(text: string): PmIdMatch[] {
  const out: PmIdMatch[] = [];
  for (const chunk of text.matchAll(CHUNK)) {
    const word = chunk[0];
    if (PATH_LIKE.test(word)) continue;
    const base = chunk.index ?? 0;
    for (const m of word.matchAll(ID_TOKEN)) {
      out.push({
        kind: m[1] as PmKind,
        id: Number(m[2]),
        index: base + (m.index ?? 0),
        length: m[0].length,
        text: m[0],
      });
    }
  }
  return out;
}
