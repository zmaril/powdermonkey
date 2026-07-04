import type { IBufferLine, ILink, Terminal } from "@xterm/xterm";

// The buffer-reading core shared by the terminal link providers (pm-id-links.ts,
// github-links.ts). Both scan a logical line of PTY text for tokens and map each
// token's char range back onto the exact buffer cells so xterm hover-underlines it.
// The token *matching* differs per provider (PM ids vs GitHub refs); the cell
// bookkeeping — walking wrapped rows, emitting a position per UTF-16 unit, turning a
// char index+length into an xterm range — is identical, and lives here.
//
// Coordinates are 1-based and a range's end is inclusive, matching xterm's convention
// (see WebLinkProvider).

/** A buffer cell position (1-based), one per emitted string char. */
export type CellPos = { x: number; y: number };

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
 *  hard-wrapped line splits one token across two rows ("t1" + "23"); joining the wrapped
 *  rows lets a matcher see "t123" as one token, and the per-char positions still map
 *  each char back to its real cell (so the link's range spans the wrap). */
export function readLogicalLine(term: Terminal, y: number): { text: string; pos: CellPos[] } {
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

/** The xterm link range for the token at char `index` spanning `length` chars, read off
 *  the per-char cell positions. Null when either end falls outside the buffer (a token
 *  that scrolled partly out of the mapped region). */
export function cellRange(pos: CellPos[], index: number, length: number): ILink["range"] | null {
  const start = pos[index];
  const end = pos[index + length - 1];
  if (!start || !end) return null;
  return { start: { x: start.x, y: start.y }, end: { x: end.x, y: end.y } };
}
