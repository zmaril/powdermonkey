import type { IBufferLine, ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { findPmIds, type PmKind } from "./pm-ids.ts";

// The PM-id link provider for the terminal — the counterpart to the WebLinksAddon
// that already linkifies URLs in the same PTY stream. xterm asks a provider for the
// links on a given buffer row (provideLinks); we scan that row's text for PM id
// tokens (pm-ids.ts) and hand back one link per token, mapped onto the exact cells so
// xterm hover-underlines it. Clicking calls `onActivate(kind, id)` — wired to the
// store's revealEntity so the operator jumps to the entity in the UI.
//
// The row text and the cell coordinates are read straight off the live buffer, so a
// link tracks the id wherever it scrolls. Coordinates are 1-based and the range end is
// inclusive, matching xterm's convention (see WebLinkProvider).

/** Called when a linked id is clicked. */
export type PmIdActivate = (kind: PmKind, id: number) => void;

/** A buffer cell position (1-based), one per emitted string char. */
type CellPos = { x: number; y: number };

/** Append a buffer row's cells to `chars`/`pos`, skipping the empty right half of a wide
 *  (CJK/emoji) cell so the string indices line up with cells. `y` is the row's 1-based
 *  buffer line number. */
function appendRow(line: IBufferLine, y: number, chars: string[], pos: CellPos[]): void {
  for (let i = 0; i < line.length; i++) {
    const cell = line.getCell(i);
    if (!cell || cell.getWidth() === 0) continue;
    const c = cell.getChars() || " ";
    // A cell can carry more than one UTF-16 unit (a surrogate pair / combining mark);
    // emit a position per unit so `index` from the matcher maps 1:1 onto cells.
    for (let k = 0; k < c.length; k++) {
      chars.push(c[k]);
      pos.push({ x: i + 1, y });
    }
  }
}

/** Read the full *logical* line containing buffer row `y` (1-based) — i.e. the row plus
 *  every wrapped continuation around it — into its text and per-char cell positions. A
 *  hard-wrapped line splits one id across two rows ("t1" + "23"); joining the wrapped
 *  rows lets the matcher see "t123" as one token, and the per-char positions still map
 *  each char back to its real cell (so the link's range spans the wrap). */
function readLogicalLine(term: Terminal, y: number): { text: string; pos: CellPos[] } {
  const buf = term.buffer.active;
  // Walk up to the first row of the wrapped run (a row is `isWrapped` when it continues
  // the one above it).
  let top = y - 1;
  while (top > 0 && buf.getLine(top)?.isWrapped) top--;

  const chars: string[] = [];
  const pos: CellPos[] = [];
  for (let row = top; ; row++) {
    const line = buf.getLine(row);
    if (!line) break;
    if (row !== top && !line.isWrapped) break; // next logical line — stop
    appendRow(line, row + 1, chars, pos);
  }
  return { text: chars.join(""), pos };
}

export class PmIdLinkProvider implements ILinkProvider {
  constructor(
    private readonly term: Terminal,
    private readonly onActivate: PmIdActivate,
  ) {}

  provideLinks(y: number, callback: (links: ILink[] | undefined) => void): void {
    if (!this.term.buffer.active.getLine(y - 1)) {
      callback(undefined);
      return;
    }
    const { text, pos } = readLogicalLine(this.term, y);

    const links: ILink[] = [];
    for (const m of findPmIds(text)) {
      const start = pos[m.index];
      const end = pos[m.index + m.length - 1];
      if (!start || !end) continue;
      const { kind, id } = m;
      links.push({
        text: m.text,
        range: { start: { x: start.x, y: start.y }, end: { x: end.x, y: end.y } },
        activate: () => this.onActivate(kind, id),
      });
    }
    callback(links.length > 0 ? links : undefined);
  }
}
