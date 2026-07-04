import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { findGithubRefs, githubRefUrl } from "./github-refs.ts";
import { cellRange, readLogicalLine } from "./terminal-link-cells.ts";

// The GitHub-ref link provider for the terminal — a sibling of PmIdLinkProvider
// (pm-id-links.ts) over the same PTY stream. xterm asks a provider for the links on a
// buffer row (provideLinks); we scan that row's text for GitHub issue/PR references
// (github-refs.ts) and hand back one link per token, mapped onto the exact cells
// (terminal-link-cells.ts) so xterm hover-underlines it. Clicking calls
// `onActivate(url)` — wired in ShellTerminal to open the github.com PR/issue page in a
// new tab.
//
// A fully-qualified `owner/repo#123` links straight to that repo. A bare `#123` / `GH-123`
// has no repo of its own, so it's resolved against the terminal's repo context: `repoSlug`
// returns the `owner/name` slug this terminal runs against (its session/task's repo — see
// ShellTerminal), so a multi-repo set of terminals each link a bare ref to the right repo.
// When there's no context slug (a supervisor/cwd shell with no pinned repo), a bare ref is
// left unlinked; a qualified ref still links.

/** Called with the github.com URL when a reference is clicked. */
export type GithubRefActivate = (url: string) => void;

export class GithubRefLinkProvider implements ILinkProvider {
  constructor(
    private readonly term: Terminal,
    private readonly onActivate: GithubRefActivate,
    /** The `owner/name` slug of the terminal's repo context, for resolving bare refs.
     *  A thunk so it always reads the latest (the terminal outlives a repo change). */
    private readonly repoSlug: () => string | undefined,
  ) {}

  provideLinks(y: number, callback: (links: ILink[] | undefined) => void): void {
    if (!this.term.buffer.active.getLine(y - 1)) {
      callback(undefined);
      return;
    }
    const { text, pos } = readLogicalLine(this.term, y);

    const links: ILink[] = [];
    for (const m of findGithubRefs(text)) {
      // A qualified ref carries its own repo; a bare one resolves against the terminal's
      // context. No slug either way (bare ref, no context) → not linkable, skip it.
      const slug = m.repo ?? this.repoSlug();
      if (!slug) continue;
      const range = cellRange(pos, m.index, m.length);
      if (!range) continue;
      const url = githubRefUrl(slug, m.number);
      links.push({ text: m.text, range, activate: () => this.onActivate(url) });
    }
    callback(links.length > 0 ? links : undefined);
  }
}
