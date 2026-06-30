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
// "part3", the "g5" inside "svg5", and so on are left alone. Exclusion of ids that sit
// inside URLs / filesystem paths is layered on in findPmIds (see 867).
const ID_TOKEN = /\b([gmtps])(\d+)\b/g;

/** Find every standalone PM id token in `text`, in order. Pure — the link provider
 *  maps each match's `index`/`length` back onto terminal buffer cells. */
export function findPmIds(text: string): PmIdMatch[] {
  const out: PmIdMatch[] = [];
  for (const m of text.matchAll(ID_TOKEN)) {
    out.push({
      kind: m[1] as PmKind,
      id: Number(m[2]),
      index: m.index ?? 0,
      length: m[0].length,
      text: m[0],
    });
  }
  return out;
}
