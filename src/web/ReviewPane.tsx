import {
  Anchor,
  Badge,
  Box,
  Button,
  Group,
  SegmentedControl,
  Stack,
  Text,
  Textarea,
} from "@mantine/core";
import { useCallback, useEffect, useState } from "react";
import type { DiffLine, Hunk } from "../server/diff.ts";
import type { PrReview, ReviewComment, ReviewFile } from "../server/pr-review.ts";
import { api } from "./client.ts";

// The in-app PR review pane: a PR's diff with inline review comments threaded under
// the lines they anchor to, and a composer to post new ones — so a review happens
// here, in the single pane of glass, instead of bouncing out to github.com. The
// server (pr-review.ts) does the GitHub I/O via `gh`; this is pure rendering off
// the /prs/:n/review payload plus a POST per comment.
//
// Two layouts, toggled: Unified (one column, +/- interleaved) and Split (old left,
// new right). Comments anchor the same way in both — RIGHT/new-line for added or
// context lines, LEFT/old-line for removed — so the thread + composer code is shared.

type Side = "LEFT" | "RIGHT";
type LineAnchor = { side: Side; line: number };

const COL = {
  add: "#12331f",
  del: "#3a1518",
  addNo: "#1a4d2e",
  delNo: "#5c2126",
  gutter: "#787f87",
  context: "transparent",
} as const;

/** Where a diff line carries a comment: the new side for added/context lines, the
 *  old side for removed lines. Null when the relevant line number is missing. */
function anchorOf(line: DiffLine): LineAnchor | null {
  if (line.type === "del")
    return line.oldLine != null ? { side: "LEFT", line: line.oldLine } : null;
  return line.newLine != null ? { side: "RIGHT", line: line.newLine } : null;
}

const keyOf = (path: string, a: LineAnchor) => `${path}::${a.side}::${a.line}`;

/** Index comments by anchor (top-level only) and by parent (replies), so each line
 *  can find its threads and each thread its replies. */
function indexComments(comments: ReviewComment[], path: string) {
  const topByAnchor = new Map<string, ReviewComment[]>();
  const repliesByParent = new Map<number, ReviewComment[]>();
  for (const c of comments) {
    if (c.path !== path) continue;
    if (c.inReplyToId != null) {
      const list = repliesByParent.get(c.inReplyToId) ?? [];
      list.push(c);
      repliesByParent.set(c.inReplyToId, list);
      continue;
    }
    if (c.line == null) continue;
    const k = keyOf(path, { side: c.side ?? "RIGHT", line: c.line });
    const list = topByAnchor.get(k) ?? [];
    list.push(c);
    topByAnchor.set(k, list);
  }
  return { topByAnchor, repliesByParent };
}

function CommentCard({ comment }: { comment: ReviewComment }) {
  return (
    <Box
      px="sm"
      py={6}
      style={{ borderLeft: "2px solid #4c5568", background: "#202225", borderRadius: 4 }}
    >
      <Group gap={6} mb={2}>
        <Text size="xs" fw={700}>
          {comment.user}
        </Text>
        {comment.url && (
          <Anchor href={comment.url} target="_blank" size="xs" c="dimmed">
            ↗
          </Anchor>
        )}
      </Group>
      <Text size="xs" style={{ whiteSpace: "pre-wrap" }}>
        {comment.body}
      </Text>
    </Box>
  );
}

/** One anchored thread: the root comment, its replies, and a reply composer. */
function Thread({
  roots,
  repliesByParent,
  onReply,
  posting,
}: {
  roots: ReviewComment[];
  repliesByParent: Map<number, ReviewComment[]>;
  onReply: (inReplyTo: number, body: string) => Promise<void>;
  posting: boolean;
}) {
  const [replyTo, setReplyTo] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  return (
    <Stack gap={6} px="md" py={6} style={{ background: "#1c1d20" }}>
      {roots.map((root) => {
        const replies = repliesByParent.get(root.id) ?? [];
        return (
          <Stack key={root.id} gap={4}>
            <CommentCard comment={root} />
            {replies.map((r) => (
              <Box key={r.id} pl="md">
                <CommentCard comment={r} />
              </Box>
            ))}
            {replyTo === root.id ? (
              <Box pl="md">
                <Textarea
                  autosize
                  minRows={2}
                  size="xs"
                  placeholder="Reply…"
                  value={draft}
                  onChange={(e) => setDraft(e.currentTarget.value)}
                />
                <Group gap={6} mt={4}>
                  <Button
                    size="compact-xs"
                    loading={posting}
                    disabled={!draft.trim()}
                    onClick={async () => {
                      await onReply(root.id, draft);
                      setDraft("");
                      setReplyTo(null);
                    }}
                  >
                    Reply
                  </Button>
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    color="gray"
                    onClick={() => setReplyTo(null)}
                  >
                    Cancel
                  </Button>
                </Group>
              </Box>
            ) : (
              <Anchor component="button" size="xs" c="dimmed" onClick={() => setReplyTo(root.id)}>
                ↳ reply
              </Anchor>
            )}
          </Stack>
        );
      })}
    </Stack>
  );
}

/** The new-comment composer shown when a line's "+" is clicked. */
function Composer({
  onSubmit,
  onCancel,
  posting,
}: {
  onSubmit: (body: string) => Promise<void>;
  onCancel: () => void;
  posting: boolean;
}) {
  const [draft, setDraft] = useState("");
  return (
    <Box px="md" py={6} style={{ background: "#1c1d20" }}>
      <Textarea
        autosize
        minRows={2}
        size="xs"
        placeholder="Leave a comment on this line…"
        value={draft}
        onChange={(e) => setDraft(e.currentTarget.value)}
        autoFocus
      />
      <Group gap={6} mt={4}>
        <Button
          size="compact-xs"
          loading={posting}
          disabled={!draft.trim()}
          onClick={() => onSubmit(draft)}
        >
          Comment
        </Button>
        <Button size="compact-xs" variant="subtle" color="gray" onClick={onCancel}>
          Cancel
        </Button>
      </Group>
    </Box>
  );
}

// A rendered cell in either layout: a diff line plus the column it sits in (unified
// rows have one cell; split rows have an optional left and right).
type Cell = { line: DiffLine | null };

/** Pair a hunk's lines into split rows: context aligns on both sides, and a run of
 *  removals is zipped against the following run of additions (leftovers stand
 *  alone) so a typical edit lines up old-vs-new. */
function toSplitRows(hunk: Hunk): { left: Cell; right: Cell }[] {
  const rows: { left: Cell; right: Cell }[] = [];
  const lines = hunk.lines;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.type === "context") {
      rows.push({ left: { line }, right: { line } });
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i].type === "del") dels.push(lines[i++]);
    while (i < lines.length && lines[i].type === "add") adds.push(lines[i++]);
    const n = Math.max(dels.length, adds.length);
    for (let j = 0; j < n; j++) {
      rows.push({ left: { line: dels[j] ?? null }, right: { line: adds[j] ?? null } });
    }
  }
  return rows;
}

function bg(line: DiffLine | null): string {
  if (!line) return "#161718";
  return line.type === "add" ? COL.add : line.type === "del" ? COL.del : COL.context;
}

const mono = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 12,
  lineHeight: "18px",
} as const;

/** A line's content cell with a hover "+" that opens the composer for that line. */
function LineContent({
  line,
  num,
  onAdd,
}: {
  line: DiffLine | null;
  num: number | null;
  onAdd: (() => void) | null;
}) {
  const [hover, setHover] = useState(false);
  return (
    <Box
      style={{ display: "flex", background: bg(line), minHeight: 18, position: "relative" }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <Box
        style={{
          width: 40,
          flexShrink: 0,
          textAlign: "right",
          paddingRight: 8,
          color: COL.gutter,
          userSelect: "none",
          ...mono,
        }}
      >
        {num ?? ""}
      </Box>
      {onAdd && hover && (
        <Box
          component="button"
          onClick={onAdd}
          title="Comment on this line"
          style={{
            position: "absolute",
            left: 44,
            top: 0,
            height: 18,
            width: 16,
            border: "none",
            cursor: "pointer",
            background: "#2f6fd1",
            color: "#fff",
            borderRadius: 3,
            padding: 0,
            ...mono,
          }}
        >
          +
        </Box>
      )}
      <Box
        style={{ flex: 1, whiteSpace: "pre-wrap", wordBreak: "break-all", paddingLeft: 8, ...mono }}
      >
        <Text span style={{ color: COL.gutter, userSelect: "none" }}>
          {line ? (line.type === "add" ? "+" : line.type === "del" ? "-" : " ") : ""}
        </Text>
        {line?.content}
      </Box>
    </Box>
  );
}

function FileView({
  file,
  comments,
  view,
  onAdd,
  onReply,
  composerKey,
  onCancelCompose,
  onSubmitCompose,
  posting,
}: {
  file: ReviewFile;
  comments: ReviewComment[];
  view: "unified" | "split";
  onAdd: (path: string, a: LineAnchor) => void;
  onReply: (inReplyTo: number, body: string) => Promise<void>;
  composerKey: string | null;
  onCancelCompose: () => void;
  onSubmitCompose: (body: string) => Promise<void>;
  posting: boolean;
}) {
  const [open, setOpen] = useState(true);
  const { topByAnchor, repliesByParent } = indexComments(comments, file.filename);

  // The comment thread + composer + add-button affordance for a given line, shared
  // by both layouts. Returns the row plus any attachments stacked beneath it.
  const attachments = (line: DiffLine | null) => {
    if (!line) return null;
    const a = anchorOf(line);
    if (!a) return null;
    const k = keyOf(file.filename, a);
    const roots = topByAnchor.get(k);
    const composing = composerKey === k;
    return (
      <>
        {roots && roots.length > 0 && (
          <Thread
            roots={roots}
            repliesByParent={repliesByParent}
            onReply={onReply}
            posting={posting}
          />
        )}
        {composing && (
          <Composer onSubmit={onSubmitCompose} onCancel={onCancelCompose} posting={posting} />
        )}
      </>
    );
  };

  return (
    <Box style={{ border: "1px solid #2c2e33", borderRadius: 6, overflow: "hidden" }}>
      <Group
        justify="space-between"
        px="sm"
        py={6}
        style={{ background: "#202225", cursor: "pointer" }}
        onClick={() => setOpen((o) => !o)}
      >
        <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
          <Text size="xs" c="dimmed">
            {open ? "▾" : "▸"}
          </Text>
          <Text size="sm" ff="monospace" truncate>
            {file.previousFilename ? `${file.previousFilename} → ` : ""}
            {file.filename}
          </Text>
          <Badge size="xs" variant="light" color="gray">
            {file.status}
          </Badge>
        </Group>
        <Group gap={8} wrap="nowrap">
          <Text size="xs" c="green">
            +{file.additions}
          </Text>
          <Text size="xs" c="red">
            -{file.deletions}
          </Text>
        </Group>
      </Group>

      {open &&
        (file.hunks.length === 0 ? (
          <Text size="xs" c="dimmed" px="md" py="sm">
            No textual diff (binary, rename, or too large to display).
          </Text>
        ) : (
          file.hunks.map((hunk) => (
            <Box key={hunk.header}>
              <Box px="md" py={2} style={{ background: "#191b1f", ...mono, color: "#5b8fb0" }}>
                {hunk.header}
              </Box>
              {view === "unified"
                ? hunk.lines.map((line, idx) => {
                    const a = anchorOf(line);
                    const num = line.type === "del" ? line.oldLine : line.newLine;
                    return (
                      <Box key={`${hunk.header}-${idx}`}>
                        <LineContent
                          line={line}
                          num={num}
                          onAdd={a ? () => onAdd(file.filename, a) : null}
                        />
                        {attachments(line)}
                      </Box>
                    );
                  })
                : toSplitRows(hunk).map((row, idx) => (
                    <Box key={`${hunk.header}-s-${idx}`}>
                      <Box style={{ display: "flex" }}>
                        <Box style={{ flex: 1, minWidth: 0, borderRight: "1px solid #2c2e33" }}>
                          <LineContent
                            line={row.left.line}
                            num={row.left.line?.oldLine ?? null}
                            onAdd={
                              row.left.line && anchorOf(row.left.line)
                                ? () =>
                                    onAdd(
                                      file.filename,
                                      anchorOf(row.left.line as DiffLine) as LineAnchor,
                                    )
                                : null
                            }
                          />
                        </Box>
                        <Box style={{ flex: 1, minWidth: 0 }}>
                          <LineContent
                            line={row.right.line}
                            num={row.right.line?.newLine ?? null}
                            onAdd={
                              row.right.line && anchorOf(row.right.line)
                                ? () =>
                                    onAdd(
                                      file.filename,
                                      anchorOf(row.right.line as DiffLine) as LineAnchor,
                                    )
                                : null
                            }
                          />
                        </Box>
                      </Box>
                      {attachments(row.left.line)}
                      {attachments(row.right.line)}
                    </Box>
                  ))}
            </Box>
          ))
        ))}
    </Box>
  );
}

export function ReviewPane({ number }: { number: number }) {
  const [review, setReview] = useState<PrReview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"unified" | "split">("unified");
  const [posting, setPosting] = useState(false);
  // The line currently being commented on: `${path}::${side}::${line}`, plus the
  // resolved anchor so we know what to POST.
  const [compose, setCompose] = useState<{ key: string; path: string; anchor: LineAnchor } | null>(
    null,
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error } = await api.prs({ number }).review.get();
    if (error) setError(String((error.value as { error?: string })?.error ?? error.status));
    else setReview(data as PrReview);
    setLoading(false);
  }, [number]);

  useEffect(() => {
    load();
  }, [load]);

  const post = async (body: string, anchor: LineAnchor, path: string, inReplyTo?: number) => {
    if (!review) return;
    setPosting(true);
    try {
      const { error } = await api.prs({ number }).comments.post({
        body,
        commitId: review.headSha,
        path,
        line: anchor.line,
        side: anchor.side,
        ...(inReplyTo != null ? { inReplyTo } : {}),
      });
      if (error) {
        setError(String((error.value as { error?: string })?.error ?? error.status));
        return;
      }
      setCompose(null);
      await load(); // refetch so the new comment threads in with correct ids
    } finally {
      setPosting(false);
    }
  };

  return (
    <Box
      style={{ height: "100%", display: "flex", flexDirection: "column", background: "#1a1b1e" }}
    >
      <Group justify="space-between" px="md" py={8} style={{ flex: "0 0 auto" }} wrap="nowrap">
        <Group gap={8} style={{ minWidth: 0 }}>
          <Text size="xs" c="dimmed" fw={700} style={{ letterSpacing: 0.5, flexShrink: 0 }}>
            REVIEW
          </Text>
          <Text size="sm" fw={500} truncate>
            {review ? `#${review.number} ${review.title}` : `PR #${number}`}
          </Text>
          {review?.url && (
            <Anchor
              href={review.url}
              target="_blank"
              size="xs"
              c="dimmed"
              style={{ flexShrink: 0 }}
            >
              ↗
            </Anchor>
          )}
        </Group>
        <Group gap={8} wrap="nowrap">
          <SegmentedControl
            size="xs"
            value={view}
            onChange={(v) => setView(v as "unified" | "split")}
            data={[
              { label: "Unified", value: "unified" },
              { label: "Split", value: "split" },
            ]}
          />
          <Button size="compact-xs" variant="default" onClick={load} loading={loading}>
            Refresh
          </Button>
        </Group>
      </Group>

      <Box style={{ flex: 1, overflowY: "auto" }} px="sm" py={4}>
        {error && (
          <Text c="red" size="sm" px="sm" py="sm">
            {error}
          </Text>
        )}
        {loading && !review ? (
          <Text c="dimmed" size="sm" px="sm" py="lg">
            Loading diff…
          </Text>
        ) : review && review.files.length === 0 ? (
          <Text c="dimmed" size="sm" px="sm" py="lg">
            No files in this PR.
          </Text>
        ) : (
          <Stack gap="sm">
            {review?.files.map((file) => (
              <FileView
                key={file.filename}
                file={file}
                comments={review.comments}
                view={view}
                composerKey={compose?.key ?? null}
                onAdd={(path, anchor) => setCompose({ key: keyOf(path, anchor), path, anchor })}
                onCancelCompose={() => setCompose(null)}
                onSubmitCompose={(body) =>
                  compose ? post(body, compose.anchor, compose.path) : Promise.resolve()
                }
                onReply={(inReplyTo, body) => {
                  // A reply re-uses the parent's anchor only for the (unused on the
                  // reply path) line/side; the server ignores them when in_reply_to is set.
                  const parent = review.comments.find((c) => c.id === inReplyTo);
                  const anchor: LineAnchor = {
                    side: parent?.side ?? "RIGHT",
                    line: parent?.line ?? 1,
                  };
                  return post(body, anchor, parent?.path ?? file.filename, inReplyTo);
                }}
                posting={posting}
              />
            ))}
          </Stack>
        )}
      </Box>
    </Box>
  );
}
