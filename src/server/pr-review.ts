import { join } from "node:path";
import {
  classifyFile,
  type GeneratedReason,
  type LinguistRule,
  parseGitattributes,
} from "./generated.ts";
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
  /** The raw unified `patch` GitHub returns for this file (with a reconstructed
   *  `diff --git`/`---`/`+++` header) — fed straight to @pierre/diffs' PatchDiff for
   *  rendering. Empty for binary/too-large files. */
  patch: string;
  /** Generated/vendored (lockfile, bundle, node_modules, …) — collapsed by default
   *  in the review pane the way GitHub folds them. See generated.ts. */
  generated: boolean;
  /** Why it's collapsed, for the file header (null when not generated). */
  generatedReason: GeneratedReason | null;
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
  /** The PR description (markdown source), shown in the review sidebar. */
  body: string;
  state: string;
  /** Head commit sha — echoed back by the client when posting (commit_id). */
  headSha: string;
  /** Base commit sha — old side for fetching full file contents (context expansion). */
  baseSha: string;
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

/** GitHub's `files[].patch` is hunks-only (`@@ …`). @pierre/diffs' PatchDiff needs a
 *  complete single-file patch, so prepend the `diff --git` / `---` / `+++` header
 *  (with /dev/null for add/remove, the previous name for a rename). parsePatch is
 *  unaffected — it skips everything before the first `@@`. */
function fullPatch(f: Json): string {
  const hunks: string = f.patch ?? "";
  if (!hunks) return "";
  const name: string = f.filename;
  const status: string = f.status ?? "modified";
  const old = status === "renamed" ? (f.previous_filename ?? name) : name;
  const oldPath = status === "added" ? "/dev/null" : `a/${old}`;
  const newPath = status === "removed" ? "/dev/null" : `b/${name}`;
  return `diff --git a/${old} b/${name}\n--- ${oldPath}\n+++ ${newPath}\n${hunks}`;
}

function mapFiles(raw: Json[], attrs: LinguistRule[] = []): ReviewFile[] {
  return raw.map((f) => {
    const file = {
      filename: f.filename,
      status: f.status ?? "modified",
      additions: f.additions ?? 0,
      deletions: f.deletions ?? 0,
      previousFilename: f.previous_filename ?? null,
      patch: fullPatch(f),
    };
    const { generated, reason } = classifyFile(file, attrs);
    return { ...file, generated, generatedReason: reason };
  });
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
        body: fixturePr.body ?? "",
        state: fixturePr.state ?? "open",
        headSha: fixturePr.head?.sha ?? fixturePr.headSha ?? "",
        baseSha: fixturePr.base?.sha ?? fixturePr.baseSha ?? "",
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
  // Honour the repo's own .gitattributes (linguist-generated/vendored) when deciding
  // what to collapse — fetched at the PR head so it reflects this branch's rules.
  const headSha = pr.head?.sha ?? "";
  const attrs = parseGitattributes(
    await contentAtRef(`${repo.owner}/${repo.name}`, ".gitattributes", headSha),
  );
  return {
    ok: true,
    review: {
      number,
      title: pr.title ?? `PR #${number}`,
      body: pr.body ?? "",
      state: pr.state ?? "open",
      headSha,
      baseSha: pr.base?.sha ?? "",
      url: pr.html_url ?? "",
      files: mapFiles(Array.isArray(files) ? files : [], attrs),
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

// ---- batched review (approve / request changes / comment) ------------------
// Instead of posting each comment immediately (one webhook per comment = churn for
// a watching session), the pane accumulates a draft and submits it as ONE review
// via POST /pulls/:n/reviews — one event for the whole pass, plus a verdict.

export type ReviewDraftComment = {
  path: string;
  /** The (end) line the comment anchors to. */
  line: number;
  side: "LEFT" | "RIGHT";
  /** First line of a multi-line comment (omit for a single-line comment). */
  startLine?: number;
  startSide?: "LEFT" | "RIGHT";
  body: string;
};

/** APPROVE / REQUEST_CHANGES / COMMENT — the GitHub review `event`s we expose. */
export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

export type SubmitReviewBody = {
  event: ReviewEvent;
  /** Overall review summary. GitHub requires one for REQUEST_CHANGES; we also
   *  require it for a COMMENT review with no inline comments (else there's nothing
   *  to say). APPROVE may have an empty body. */
  body: string;
  /** Head sha to anchor the review to (from the review payload). */
  commitId: string;
  comments: ReviewDraftComment[];
};

export type SubmitResult = { ok: true } | { ok: false; error: string; status: number };

/** Submit a whole review in one call: all draft comments + a verdict. */
export async function submitReview(number: number, r: SubmitReviewBody): Promise<SubmitResult> {
  if (fixtureDir())
    return { ok: false, status: 400, error: "fixture mode is read-only (PM_PR_FIXTURE_DIR set)" };
  if (r.event === "REQUEST_CHANGES" && !r.body.trim())
    return { ok: false, status: 400, error: "Request changes needs a summary" };
  if (r.event === "COMMENT" && !r.body.trim() && r.comments.length === 0)
    return { ok: false, status: 400, error: "a Comment review needs a summary or inline comments" };
  const repo = await resolveRepo();
  if (!repo) return { ok: false, status: 502, error: "no GitHub repo configured" };

  // gh can't express a nested comments[] array via -f flags, so POST the JSON body
  // on stdin with `--input -`.
  const payload = JSON.stringify({
    commit_id: r.commitId || undefined,
    body: r.body || undefined,
    event: r.event,
    comments: r.comments.map((c) => ({
      path: c.path,
      line: c.line,
      side: c.side,
      // A multi-line comment carries start_line/start_side (GitHub anchors the
      // comment at `line`, the end). Omit for a single line.
      ...(c.startLine != null && c.startLine !== c.line
        ? { start_line: c.startLine, start_side: c.startSide ?? c.side }
        : {}),
      body: c.body,
    })),
  });
  const path = `repos/${repo.owner}/${repo.name}/pulls/${number}/reviews`;
  const res = await gh(["api", "--method", "POST", path, "--input", "-"], payload);
  if (!res.ok)
    return {
      ok: false,
      status: 502,
      error: res.stderr.trim().slice(0, 300) || "gh review submit failed",
    };
  return { ok: true };
}

// ---- full file contents (for context expansion) ----------------------------
// PatchDiff renders the patch alone (light); to let the operator expand collapsed
// context the renderer needs the FULL old+new file, which we fetch on demand (only
// when they ask to expand a given file) so a large PR doesn't pull every blob.

export type FileContentsResult =
  | { ok: true; oldText: string; newText: string }
  | { ok: false; error: string; status: number };

/** Decode a `gh api .../contents/<path>?ref=<sha>` response to text, or "" when the
 *  path doesn't exist at that ref (added/removed files) or isn't decodable. */
async function contentAtRef(repo: string, path: string, ref: string): Promise<string> {
  if (!ref) return "";
  const r = await ghApiJson(`repos/${repo}/contents/${encodeURIComponent(path)}?ref=${ref}`);
  if (!r || typeof r.content !== "string") return "";
  try {
    return Buffer.from(r.content, r.encoding === "base64" ? "base64" : "utf8").toString("utf8");
  } catch {
    return "";
  }
}

/** Old + new full contents of one file, for context expansion. Reads fixtures
 *  (`pr-<n>-contents.json`: `{ "<path>": { oldText, newText } }`) when offline. */
export async function getFileContents(
  number: number,
  path: string,
  base: string,
  head: string,
): Promise<FileContentsResult> {
  const fixture = await readFixture(`pr-${number}-contents.json`);
  if (fixture) {
    const entry = fixture[path];
    return { ok: true, oldText: entry?.oldText ?? "", newText: entry?.newText ?? "" };
  }
  const repo = await resolveRepo();
  if (!repo) return { ok: false, status: 502, error: "no GitHub repo configured" };
  const slug = `${repo.owner}/${repo.name}`;
  const [oldText, newText] = await Promise.all([
    contentAtRef(slug, path, base),
    contentAtRef(slug, path, head),
  ]);
  return { ok: true, oldText, newText };
}
