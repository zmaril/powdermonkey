import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { repoRepo } from "./crud.ts";
import { reposCacheRoot } from "./repo-cache.ts";
import type { Repo } from "./schema.ts";

// Repo identity icons (docs/vocabulary.md § Repo → Identity). A repo's icon is
// resolved once — try the homepage favicon, fall back to the GitHub owner avatar
// (always available) — cached on disk, and served at GET /repos/:id/icon. The
// resolved path persists in `repos.icon_path`, so resolution happens once per repo
// for its lifetime, lazily on the first icon request; every registration path
// (boot seed, POST /repos, a future picker) is covered without hooks.
//
// Icons live under `<reposCacheRoot()>/.icons/<owner>/<name>.png` — NEXT TO the
// cache clones, not inside them: writing into `<root>/<owner>/<name>` before the
// first clone would make `git clone` fail on a non-empty destination. A dot-dir
// can't collide with a GitHub owner (usernames never start with ".").

/** On-disk cache path for a slug's icon. Pure — the file may not exist yet. The
 *  ".png" name is historical labeling; the real format is whatever the source
 *  served (sniffed again at serve time). */
export function iconCachePath(slug: string): string {
  const [owner, name] = slug.split("/");
  return join(reposCacheRoot(), ".icons", owner, `${name}.png`);
}

/** The URLs to try, in order: the homepage's /favicon.ico when the repo has a
 *  homepage, then the owner avatar (github.com/<owner>.png, served for every
 *  account). Pure — exported so tests pin the ordering. */
export function iconCandidates(repo: Pick<Repo, "owner" | "homepageUrl">): string[] {
  const urls: string[] = [];
  if (repo.homepageUrl) {
    try {
      urls.push(new URL("/favicon.ico", repo.homepageUrl).toString());
    } catch {
      // A malformed homepage just drops the favicon candidate.
    }
  }
  urls.push(`https://github.com/${repo.owner}.png?size=128`);
  return urls;
}

/** Sniff an image's MIME type from its magic bytes. Returns null for anything that
 *  isn't one of the formats favicons/avatars actually come in — which is also the
 *  download-time validity check (an HTML 404 page mislabeled image/png sniffs null
 *  and is rejected, instead of being cached and served as a broken icon). */
export function sniffImageType(bytes: Uint8Array): string | null {
  const ascii = (start: number, len: number) =>
    String.fromCharCode(...bytes.slice(start, start + len));
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(1, 3) === "PNG") return "image/png";
  if (bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0)
    return "image/x-icon";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (bytes.length >= 4 && ascii(0, 4) === "GIF8") return "image/gif";
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "image/webp";
  // SVG is text; tolerate a BOM/whitespace before the first tag.
  const head = new TextDecoder().decode(bytes.slice(0, 256)).replace(/^\uFEFF/, "");
  if (/^\s*<(\?xml|svg|!doctype svg)/i.test(head)) return "image/svg+xml";
  return null;
}

// Favicons and avatars are a few KB; anything bigger than this isn't an icon.
const MAX_ICON_BYTES = 512 * 1024;

// After a failed resolution (offline, no favicon AND no avatar — rare), don't
// re-fetch on every card render; retry after this long.
const FAILURE_TTL_MS = 5 * 60_000;

const inflight = new Map<number, Promise<string | null>>();
const failedAt = new Map<number, number>();

/** Drop the resolver's in-memory state (in-flight dedupe + failure memo). Tests. */
export function resetIconResolverState(): void {
  inflight.clear();
  failedAt.clear();
}

type Fetcher = (url: string) => Promise<Response>;

const defaultFetch: Fetcher = (url) => fetch(url, { signal: AbortSignal.timeout(5000) });

/** Download the first candidate that returns a real image. Returns the bytes, or
 *  null when every candidate failed (network down, 404s, non-image bodies). */
async function downloadIcon(candidates: string[], fetchImpl: Fetcher): Promise<Uint8Array | null> {
  for (const url of candidates) {
    try {
      const res = await fetchImpl(url);
      if (!res.ok) continue;
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length === 0 || bytes.length > MAX_ICON_BYTES) continue;
      if (!sniffImageType(bytes)) continue;
      return bytes;
    } catch {
      // Unreachable host / timeout — try the next candidate.
    }
  }
  return null;
}

/** Resolve a repo's icon: favicon → owner avatar, write it to the disk cache, and
 *  persist the path on the repo row. Returns the cached path, or null when nothing
 *  resolvable was found (the repo row is left untouched, so a later call retries).
 *  Concurrent calls for the same repo share one resolution; a failure is memoized
 *  for a few minutes so a wall of cards doesn't hammer a dead network. */
export async function resolveRepoIcon(
  repo: Repo,
  fetchImpl: Fetcher = defaultFetch,
): Promise<string | null> {
  const running = inflight.get(repo.id);
  if (running) return running;
  const lastFail = failedAt.get(repo.id);
  if (lastFail && Date.now() - lastFail < FAILURE_TTL_MS) return null;

  const work = (async () => {
    const bytes = await downloadIcon(iconCandidates(repo), fetchImpl);
    if (!bytes) {
      failedAt.set(repo.id, Date.now());
      return null;
    }
    const path = iconCachePath(repo.slug);
    mkdirSync(dirname(path), { recursive: true });
    await Bun.write(path, bytes);
    await repoRepo.update(repo.id, { iconPath: path });
    failedAt.delete(repo.id);
    return path;
  })();

  inflight.set(repo.id, work);
  try {
    return await work;
  } finally {
    inflight.delete(repo.id);
  }
}

/** The GET /repos/:id/icon body: the cached icon when the repo has one (resolving
 *  and caching on the first ask), null otherwise (unknown repo, or nothing
 *  resolvable — the route 404s and the UI falls back to the color swatch). */
export async function repoIconResponse(
  repoId: number,
  fetchImpl: Fetcher = defaultFetch,
): Promise<Response | null> {
  const repo = await repoRepo.get(repoId);
  if (!repo) return null;
  const path =
    repo.iconPath && existsSync(repo.iconPath)
      ? repo.iconPath
      : await resolveRepoIcon(repo, fetchImpl);
  if (!path || !existsSync(path)) return null;
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  return new Response(bytes, {
    headers: {
      "content-type": sniffImageType(bytes) ?? "image/png",
      // Icons change ~never (resolution is once per repo); an hour keeps a wall of
      // cards from re-requesting while still picking up a re-resolve same-day.
      "cache-control": "public, max-age=3600",
    },
  });
}
