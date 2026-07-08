// straitjacket-allow-file:color  the `#N` tokens here are GitHub issue/PR references (the
// whole domain of this file), not hex colors — same intrinsic-notation carve-out as themes.ts.
//
// GitHub issue / PR references in free text — the `#123`, `owner/repo#123`, and `GH-123`
// mentions that git, gh, and the agents print all over their PTY output ("merged #66",
// "see zmaril/powdermonkey#71", "fixed GH-42"). The terminal GitHub-ref link provider
// (github-links.ts) turns them into clickable jumps to github.com — the GitHub
// counterpart to the PM-id links (pm-ids.ts) and the plain-URL links the WebLinksAddon
// already renders. This module is the pure matcher (no xterm, no DOM) so the matching
// rules stay unit-testable on their own.

export type GithubRefMatch = {
  /** The explicit `owner/name` slug when the ref carried one (`owner/repo#123`);
   *  undefined for a bare `#123` / `GH-123`, which the provider resolves against the
   *  terminal's repo context. */
  repo?: string;
  /** The issue / PR number. */
  number: number;
  /** 0-based index of the token's first char within the input string. */
  index: number;
  /** Length of the matched token in chars (e.g. "#123" → 4). */
  length: number;
  text: string;
};

// One reference token, in three forms tried in order:
//   owner/repo#123 — a fully-qualified cross-repo ref (owner: a GitHub login; name: a
//                    repo name, which may carry dots/underscores/hyphens)
//   #123           — a bare ref against the current repo
//   GH-123         — the "GH-" mention style (either case)
// The leading `(?<![\w./-])` keeps a ref from firing inside a larger token — a URL or
// path (`…/pull/6#123`, `docs/a/b#3`), a filename, or a hyphenated word — where the
// `#`/`GH-` isn't a real reference. WebLinksAddon owns actual URLs; we stay out of them.
const GITHUB_REF =
  /(?<![\w./-])(?:([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+)#(\d+)|#(\d+)|[Gg][Hh]-(\d+))\b/g;

/** Find every GitHub issue/PR reference in `text`, in order. Pure — the link provider
 *  maps each match's `index`/`length` back onto terminal buffer cells, and resolves a
 *  bare ref (`repo` undefined) against the terminal's repo context. */
export function findGithubRefs(text: string): GithubRefMatch[] {
  const out: GithubRefMatch[] = [];
  for (const m of text.matchAll(GITHUB_REF)) {
    const index = m.index ?? 0;
    // Group 1/2 = owner/repo#num; group 3 = bare #num; group 4 = GH-num.
    const repo = m[1] ?? undefined;
    const number = Number(m[2] ?? m[3] ?? m[4]);
    out.push({ repo, number, index, length: m[0].length, text: m[0] });
  }
  return out;
}

/** The github.com URL a reference points at. `/issues/<n>` intentionally — GitHub
 *  redirects it to `/pull/<n>` when the number is a PR, so one URL serves both without
 *  the text having to say which it is. */
export function githubRefUrl(slug: string, number: number): string {
  return `https://github.com/${slug}/issues/${number}`;
}
