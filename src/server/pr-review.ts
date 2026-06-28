import { join } from "node:path";
import { type Hunk, parsePatch } from "./diff.ts";
import { gh, resolveRepo } from "./gh.ts";

// Review a PR from inside PowderMonkey instead of bouncing to github.com: pull a
// PR's diff and its inline review comments, and post new inline comments back. All
// GitHub I/O goes through `gh api` (same auth the watcher already relies on), so
// there's nothing new to configure.
//
// Testing/offline seam: set PM_PR_FIXTURE_DIR to a directory of JSON dumps and the
// read paths serve those instead of calling `gh` — drop the raw output of the
// GitHub "list files" / "list review comments" / "get pull" endpoints in as
// `pr-<n>-files.json`, `pr-<n>-comments.json`, `pr-<n>.json`. Lets the UI render a
// real diff with no network (used for the screenshot recipe in CLAUDE.md).

export type ReviewFile = {
  filename: string;
  /** added | modified | removed | renamed | copied | changed */
  status: string;
  additions: number;
  deletions: number;
  previousFilename: string | null;
  hunks: Hunk[];
};

export type ReviewComment = {
  id: number;
  path: string;
  /** Line in the file the comment anchors to (new side for RIGHT, old for LEFT). */
  line: number | null;
  side: "LEFT" | "RIGHT" | null;
  body: string;
  user: string;
  createdAt: string;
  /** Set when this comment is a reply within a thread. */
  inReplyToId: number | null;
  url: string;
};

export type PrReview = {
  number: number;
  title: string;
  state: string;
  /** Head commit sha — echoed back by the client when posting (commit_id). */
  headSha: string;
  url: string;
  files: ReviewFile[];
  comments: ReviewComment[];
};

export type ReviewResult =
  | { ok: true; review: PrReview }
  | { ok: false; error: string; status: number };

// biome-ignore lint/suspicious/noExplicitAny: GitHub JSON, narrowed by the mappers below.
type Json = any;

function fixtureDir(): string | null {
  return process.env.PM_PR_FIXTURE_DIR || null;
}

async function readFixture(name: string): Promise<Json | null> {
  const dir = fixtureDir();
  if (!dir) return null;
  const file = Bun.file(join(dir, name));
  if (!(await file.exists())) return null;
  return file.json();
}

/** `gh api <path>` returning parsed JSON, or null on any failure (no gh, no auth,
 *  bad JSON). `--paginate` is safe for the list endpoints; harmless for a single
 *  object. */
async function ghApiJson(path: string, paginate = false): Promise<Json | null> {
  const args = ["api", path, "-H", "Accept: application/vnd.github+json"];
  if (paginate) args.push("--paginate");
  const r = await gh(args);
  if (!r.ok) return null;
  try {
    // --paginate concatenates pages as separate JSON arrays for some endpoints; with
    // `gh api` it merges arrays itself, so a single parse is correct here.
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

function mapFiles(raw: Json[]): ReviewFile[] {
  return raw.map((f) => ({
    filename: f.filename,
    status: f.status ?? "modified",
    additions: f.additions ?? 0,
    deletions: f.deletions ?? 0,
    previousFilename: f.previous_filename ?? null,
    hunks: parsePatch(f.patch),
  }));
}

function mapComments(raw: Json[]): ReviewComment[] {
  return raw.map((c) => ({
    id: c.id,
    path: c.path,
    // GitHub returns the current `line` (null if the line is outdated); fall back to
    // original_line so a comment on an unchanged-since line still anchors somewhere.
    line: c.line ?? c.original_line ?? null,
    side: c.side ?? "RIGHT",
    body: c.body ?? "",
    user: c.user?.login ?? "unknown",
    createdAt: c.created_at ?? "",
    inReplyToId: c.in_reply_to_id ?? null,
    url: c.html_url ?? "",
  }));
}

/** Fetch a PR's diff + inline comments. Reads from PM_PR_FIXTURE_DIR when set,
 *  otherwise three `gh api` calls. */
export async function getPrReview(number: number): Promise<ReviewResult> {
  const fixturePr = await readFixture(`pr-${number}.json`);
  if (fixturePr) {
    const files = (await readFixture(`pr-${number}-files.json`)) ?? [];
    const comments = (await readFixture(`pr-${number}-comments.json`)) ?? [];
    return {
      ok: true,
      review: {
        number,
        title: fixturePr.title ?? `PR #${number}`,
        state: fixturePr.state ?? "open",
        headSha: fixturePr.head?.sha ?? fixturePr.headSha ?? "",
        url: fixturePr.html_url ?? fixturePr.url ?? "",
        files: mapFiles(files),
        comments: mapComments(comments),
      },
    };
  }

  const repo = await resolveRepo();
  if (!repo)
    return { ok: false, status: 502, error: "no GitHub repo (set PM_GITHUB_REPO or auth `gh`)" };
  const base = `repos/${repo.owner}/${repo.name}/pulls/${number}`;
  const [pr, files, comments] = await Promise.all([
    ghApiJson(base),
    ghApiJson(`${base}/files`, true),
    ghApiJson(`${base}/comments`, true),
  ]);
  if (!pr) return { ok: false, status: 502, error: `could not load PR #${number} via gh` };
  return {
    ok: true,
    review: {
      number,
      title: pr.title ?? `PR #${number}`,
      state: pr.state ?? "open",
      headSha: pr.head?.sha ?? "",
      url: pr.html_url ?? "",
      files: mapFiles(Array.isArray(files) ? files : []),
      comments: mapComments(Array.isArray(comments) ? comments : []),
    },
  };
}

export type PostCommentBody = {
  body: string;
  /** Head sha to anchor the comment to (from the review payload). */
  commitId: string;
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  /** When set, post as a reply in an existing thread (ignores path/line/side). */
  inReplyTo?: number;
};

export type PostResult =
  | { ok: true; comment: ReviewComment }
  | { ok: false; error: string; status: number };

/** Post an inline review comment (or a threaded reply) via `gh api`. A real,
 *  outward-facing write — surfaced behind a confirm in the UI. */
export async function postPrComment(number: number, c: PostCommentBody): Promise<PostResult> {
  if (fixtureDir())
    return { ok: false, status: 400, error: "fixture mode is read-only (PM_PR_FIXTURE_DIR set)" };
  if (!c.body.trim()) return { ok: false, status: 400, error: "comment body is empty" };
  const repo = await resolveRepo();
  if (!repo) return { ok: false, status: 502, error: "no GitHub repo configured" };

  const path = `repos/${repo.owner}/${repo.name}/pulls/${number}/comments`;
  const args = ["api", "--method", "POST", path, "-f", `body=${c.body}`];
  if (c.inReplyTo != null) {
    args.push("-F", `in_reply_to=${c.inReplyTo}`);
  } else {
    args.push(
      "-f",
      `commit_id=${c.commitId}`,
      "-f",
      `path=${c.path}`,
      "-F",
      `line=${c.line}`,
      "-f",
      `side=${c.side}`,
    );
  }
  const r = await gh(args);
  if (!r.ok)
    return { ok: false, status: 502, error: r.stderr.trim().slice(0, 300) || "gh post failed" };
  try {
    return { ok: true, comment: mapComments([JSON.parse(r.stdout)])[0] };
  } catch {
    // Posted, but we couldn't parse the echo — not fatal; the client refetches.
    return { ok: false, status: 502, error: "comment posted but response was unparseable" };
  }
}
