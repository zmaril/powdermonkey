import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { findPmIds, type PmKind } from "./pm-ids.ts";
import { collectLinks } from "./terminal-link-cells.ts";

// The PM-id link provider for the terminal — the counterpart to the WebLinksAddon
// that already linkifies URLs in the same PTY stream (and a sibling of the GitHub-ref
// provider, github-links.ts). xterm asks a provider for the links on a given buffer row
// (provideLinks); we scan that row's text for PM id tokens (pm-ids.ts) and hand back one
// link per token, mapped onto the exact cells (terminal-link-cells.ts) so xterm
// hover-underlines it. Clicking calls `onActivate(kind, id)` — wired to the store's
// revealEntity so the operator jumps to the entity in the UI.
//
// The row text and the cell coordinates are read straight off the live buffer, so a
// link tracks the id wherever it scrolls.

/** Called when a linked id is clicked. */
export type PmIdActivate = (kind: PmKind, id: number) => void;

export class PmIdLinkProvider implements ILinkProvider {
  constructor(
    private readonly term: Terminal,
    private readonly onActivate: PmIdActivate,
  ) {}

  provideLinks(y: number, callback: (links: ILink[] | undefined) => void): void {
    collectLinks(
      this.term,
      y,
      findPmIds,
      (m, range) => {
        const { kind, id } = m;
        return { text: m.text, range, activate: () => this.onActivate(kind, id) };
      },
      callback,
    );
  }
}
