import {
  Anchor,
  Badge,
  Box,
  Button,
  Checkbox,
  Group,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
  Textarea,
} from "@mantine/core";
import type { DiffLineAnnotation } from "@pierre/diffs/react";
import { PatchDiff } from "@pierre/diffs/react";
import type { GitStatus } from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";
import {
  DockviewReact,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
  themeAbyss,
} from "dockview-react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import {
  type CSSProperties,
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { PrReview, ReviewComment, ReviewEvent, ReviewFile } from "../server/pr-review.ts";
import { api } from "./client.ts";

/** GitHub's per-file status → the git status @pierre/trees colours rows by. */
function mapGitStatus(status: string): GitStatus {
  switch (status) {
    case "added":
      return "added";
    case "removed":
      return "deleted";
    case "renamed":
      return "renamed";
    default:
      return "modified"; // modified / changed / copied
  }
}

// A drafted (not-yet-submitted) inline comment, accumulated locally and sent as part
// of one batched review (see submit()). `id` is a client-only key for removal.
type DraftComment = {
  id: number;
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  body: string;
};

// The in-app PR review pane: a PR's diff with inline review comments threaded under
// the lines they anchor to — so a review happens here, in the single pane of glass,
// instead of bouncing out to github.com. The server (pr-review.ts) does the GitHub
// I/O via `gh`; this is rendering off the /prs/:n/review payload.
//
// New comments accumulate into a local DRAFT and are submitted as ONE GitHub review
// (Approve / Request changes / Comment) via the footer bar — one webhook event for
// the whole pass instead of one per comment. (Replies to an existing thread still
// post immediately, since the reviews API can't express a reply.)
//
// Two layouts, toggled: Unified (one column, +/- interleaved) and Split (old left,
// new right). Comments anchor the same way in both — RIGHT/new-line for added or
// context lines, LEFT/old-line for removed — so the thread + composer code is shared.

type Side = "LEFT" | "RIGHT";
type LineAnchor = { side: Side; line: number };

const keyOf = (path: string, a: LineAnchor) => `${path}::${a.side}::${a.line}`;

// @pierre/diffs anchors annotations by 'additions' (new/right) | 'deletions'
// (old/left); map to/from our LEFT/RIGHT comment sides.
type ASide = "additions" | "deletions";
const toASide = (s: Side): ASide => (s === "LEFT" ? "deletions" : "additions");
const fromASide = (s: ASide): Side => (s === "deletions" ? "LEFT" : "RIGHT");

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

/** The new-comment composer shown when a line's "+" is clicked. `submitLabel` is
 *  "Add to review" for a fresh line comment (batched) and "Reply" for a thread
 *  reply (posted immediately). */
function Composer({
  onSubmit,
  onCancel,
  posting,
  submitLabel = "Add to review",
}: {
  onSubmit: (body: string) => void | Promise<void>;
  onCancel: () => void;
  posting: boolean;
  submitLabel?: string;
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
          {submitLabel}
        </Button>
        <Button size="compact-xs" variant="subtle" color="gray" onClick={onCancel}>
          Cancel
        </Button>
      </Group>
    </Box>
  );
}

/** A drafted comment shown under its line before the review is submitted — a dashed
 *  amber card with a remove affordance, visually distinct from posted comments. */
function PendingCard({ draft, onRemove }: { draft: DraftComment; onRemove: () => void }) {
  return (
    <Box px="md" py={6} style={{ background: "#1c1d20" }}>
      <Box
        px="sm"
        py={6}
        style={{ border: "1px dashed #b8893a", background: "#221d16", borderRadius: 4 }}
      >
        <Group justify="space-between" mb={2} wrap="nowrap">
          <Badge size="xs" variant="light" color="yellow">
            pending
          </Badge>
          <Anchor component="button" size="xs" c="dimmed" onClick={onRemove}>
            remove
          </Anchor>
        </Group>
        <Text size="xs" style={{ whiteSpace: "pre-wrap" }}>
          {draft.body}
        </Text>
      </Box>
    </Box>
  );
}

// Shiki theme @pierre/diffs renders the diff with — a dark one to match the panes.
const DIFF_THEME = "github-dark";

type AnnMeta = { path: string; line: number; side: Side };

/** Parse a comment anchor key (`path::SIDE::line`) back into its parts. Filenames
 *  don't contain "::", so the trailing `::SIDE::line` is unambiguous. */
function parseKey(key: string): AnnMeta | null {
  const m = key.match(/^(.*)::(LEFT|RIGHT)::(\d+)$/);
  return m ? { path: m[1], side: m[2] as Side, line: Number(m[3]) } : null;
}

/** One file's diff, rendered by @pierre/diffs' PatchDiff (Shiki highlighting,
 *  split/unified, virtualized) from the raw GitHub patch. Inline comment threads,
 *  pending drafts, and the composer are injected via its annotation framework; the
 *  gutter "+" opens the composer for a line. */
function FilePatch({ file }: { file: ReviewFile }) {
  const {
    review,
    view,
    draftByKey,
    removeDraft,
    composeKey,
    onAdd,
    onCancelCompose,
    onSubmitCompose,
    onReply,
    posting,
  } = useReviewCtx();
  const { topByAnchor, repliesByParent } = indexComments(review.comments, file.filename);

  // Every line that needs an annotation row: posted threads, pending drafts, and the
  // open composer — deduped to one annotation per (side, line).
  const annotations = useMemo(() => {
    const seen = new Set<string>();
    const out: DiffLineAnnotation<AnnMeta>[] = [];
    const add = (side: Side, line: number) => {
      const k = keyOf(file.filename, { side, line });
      if (seen.has(k)) return;
      seen.add(k);
      out.push({
        side: toASide(side),
        lineNumber: line,
        metadata: { path: file.filename, line, side },
      });
    };
    for (const c of review.comments)
      if (c.path === file.filename && c.inReplyToId == null && c.line != null)
        add(c.side ?? "RIGHT", c.line);
    for (const [, drafts] of draftByKey) {
      const d = drafts[0];
      if (d?.path === file.filename) add(d.side, d.line);
    }
    const target = composeKey ? parseKey(composeKey) : null;
    if (target?.path === file.filename) add(target.side, target.line);
    return out;
  }, [file.filename, review.comments, draftByKey, composeKey]);

  const renderAnnotation = (ann: DiffLineAnnotation<AnnMeta>) => {
    const { side, line } = ann.metadata;
    const k = keyOf(file.filename, { side, line });
    const roots = topByAnchor.get(k);
    const drafts = draftByKey.get(k);
    return (
      <Box style={{ borderTop: "1px solid #2c2e33", borderBottom: "1px solid #2c2e33" }}>
        {roots && roots.length > 0 && (
          <Thread
            roots={roots}
            repliesByParent={repliesByParent}
            onReply={onReply}
            posting={posting}
          />
        )}
        {drafts?.map((d) => (
          <PendingCard key={d.id} draft={d} onRemove={() => removeDraft(d.id)} />
        ))}
        {composeKey === k && (
          <Composer onSubmit={onSubmitCompose} onCancel={onCancelCompose} posting={posting} />
        )}
      </Box>
    );
  };

  // Open the composer for a line. Both affordances route here: the gutter "+" (hover)
  // and clicking the line number — whichever the operator reaches for.
  const addAt = (side: ASide | undefined, line: number) =>
    onAdd(file.filename, { side: fromASide(side ?? "additions"), line });

  return (
    <PatchDiff<AnnMeta>
      patch={file.patch}
      disableWorkerPool
      options={{
        diffStyle: view === "split" ? "split" : "unified",
        theme: DIFF_THEME,
        themeType: "dark",
        disableFileHeader: true,
        enableGutterUtility: true,
        // The hover "+" in the gutter — passes the clicked line/side directly.
        onGutterUtilityClick: (range: { start: number; side?: ASide }) =>
          addAt(range.side, range.start),
        // Clicking a line number also starts a comment (reliable, GitHub-like).
        onLineNumberClick: (props: { lineNumber: number; annotationSide?: ASide }) =>
          addAt(props.annotationSide, props.lineNumber),
      }}
      lineAnnotations={annotations}
      renderAnnotation={renderAnnotation}
    />
  );
}

/** Mount `children` only once the slot scrolls near the viewport, so a many-file PR
 *  doesn't run every file's Shiki highlight up front — the practical win of
 *  virtualization without rewriting onto CodeView. A height-estimate placeholder
 *  keeps the scrollbar roughly stable; once shown it stays mounted (so comment/
 *  composer state isn't lost on scroll). */
function LazyMount({ estimate, children }: { estimate: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (show) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShow(true);
          io.disconnect();
        }
      },
      { rootMargin: "800px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [show]);
  return <div ref={ref}>{show ? children : <div style={{ height: estimate }} />}</div>;
}

/** Rough rendered height of a patch (line count × row height), for the lazy-mount
 *  placeholder. Capped so a huge file doesn't blow out the scrollbar estimate. */
function estimateHeight(patch: string): number {
  return Math.min(40 + patch.split("\n").length * 18, 4000);
}

/** One file in the diff list: our header (name · status · +/- · Viewed) over the
 *  PatchDiff. Marking it viewed collapses the diff (GitHub's mechanic). */
function FileBlock({ file }: { file: ReviewFile }) {
  const { viewed, toggleViewed } = useReviewCtx();
  const isViewed = viewed.has(file.filename);
  return (
    <Box style={{ border: "1px solid #2c2e33", borderRadius: 6, overflow: "hidden" }}>
      <Group justify="space-between" px="sm" py={6} style={{ background: "#202225" }}>
        <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
          <Text size="sm" ff="monospace" truncate>
            {file.previousFilename ? `${file.previousFilename} → ` : ""}
            {file.filename}
          </Text>
          <Badge size="xs" variant="light" color="gray">
            {file.status}
          </Badge>
        </Group>
        <Group gap={10} wrap="nowrap">
          <Text size="xs" c="green">
            +{file.additions}
          </Text>
          <Text size="xs" c="red">
            -{file.deletions}
          </Text>
          <Checkbox
            size="xs"
            label="Viewed"
            checked={isViewed}
            onChange={() => toggleViewed(file.filename)}
            styles={{ label: { fontSize: 11, color: "#909296", paddingLeft: 6 } }}
          />
        </Group>
      </Group>
      {!isViewed &&
        (file.patch ? (
          <LazyMount estimate={estimateHeight(file.patch)}>
            <FilePatch file={file} />
          </LazyMount>
        ) : (
          <Text size="xs" c="dimmed" px="md" py="sm">
            No textual diff (binary, rename, or too large to display).
          </Text>
        ))}
    </Box>
  );
}

// Theme the @pierre/trees shadow-DOM tree to match the app's dark panes. The tree's
// base colours default to a light theme, so set the full `--trees-*-override` set
// (custom properties pierce the shadow boundary, so the host is enough) — leaving
// only some overridden makes the tree render mostly white.
const TREE_VARS: CSSProperties = {
  background: "#1a1b1e",
  "--trees-bg-override": "#1a1b1e",
  "--trees-bg-muted-override": "#202225",
  "--trees-fg-override": "#c1c2c5",
  "--trees-fg-muted-override": "#909296",
  "--trees-border-color-override": "#2c2e33",
  "--trees-accent-override": "#4dabf7",
  "--trees-selected-bg-override": "#2f3136",
  "--trees-selected-fg-override": "#ffffff",
  "--trees-selected-focused-border-color-override": "#4dabf7",
  "--trees-indent-guide-bg-override": "#2c2e33",
  "--trees-scrollbar-thumb-override": "#3a3d44",
  "--trees-focus-ring-color-override": "#4dabf7",
} as CSSProperties;

// The review's shared state, handed to the dockview panels (Description, Files) so
// each can render its slice. dockview-react renders panels through React portals,
// which preserve context from above <DockviewReact>, so this reaches them without
// threading data through panel params.
type ReviewCtxValue = {
  review: PrReview;
  view: "unified" | "split";
  draftByKey: Map<string, DraftComment[]>;
  removeDraft: (id: number) => void;
  composeKey: string | null;
  onAdd: (path: string, a: LineAnchor) => void;
  onCancelCompose: () => void;
  onSubmitCompose: (body: string) => void;
  onReply: (inReplyTo: number, body: string) => Promise<void>;
  posting: boolean;
  viewed: Set<string>;
  toggleViewed: (path: string) => void;
  registerFileEl: (path: string, el: HTMLDivElement | null) => void;
  scrollToFile: (path: string) => void;
};
const ReviewCtx = createContext<ReviewCtxValue | null>(null);
function useReviewCtx(): ReviewCtxValue {
  const c = useContext(ReviewCtx);
  if (!c) throw new Error("ReviewCtx used outside the review overlay");
  return c;
}

// Dark-theme styles for rendered markdown, injected once. Scoped to `.pm-md`.
let mdStylesInjected = false;
function ensureMdStyles() {
  if (mdStylesInjected || typeof document === "undefined") return;
  mdStylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
.pm-md{color:#c1c2c5;font-size:13px;line-height:1.55;word-break:break-word;}
.pm-md>*:first-child{margin-top:0;}
.pm-md h1,.pm-md h2,.pm-md h3,.pm-md h4{color:#e9ecef;margin:14px 0 6px;line-height:1.3;}
.pm-md h1{font-size:18px;} .pm-md h2{font-size:16px;} .pm-md h3{font-size:14px;} .pm-md h4{font-size:13px;}
.pm-md p{margin:6px 0;} .pm-md a{color:#4dabf7;}
.pm-md code{background:#2b2d31;padding:1px 4px;border-radius:3px;font-family:ui-monospace,Menlo,monospace;font-size:12px;}
.pm-md pre{background:#16171a;border:1px solid #2c2e33;border-radius:6px;padding:10px;overflow:auto;}
.pm-md pre code{background:none;padding:0;}
.pm-md ul,.pm-md ol{margin:6px 0;padding-left:20px;} .pm-md li{margin:2px 0;}
.pm-md blockquote{border-left:3px solid #3a3d44;margin:6px 0;padding:2px 10px;color:#a6a7ab;}
.pm-md table{border-collapse:collapse;margin:6px 0;} .pm-md th,.pm-md td{border:1px solid #2c2e33;padding:4px 8px;}
.pm-md img{max-width:100%;} .pm-md hr{border:none;border-top:1px solid #2c2e33;margin:12px 0;}
.pm-md-inline,.pm-md-inline p{display:inline;margin:0;font-size:inherit;}
`;
  document.head.appendChild(style);
}

/** Render GitHub-flavoured markdown, sanitized (PR descriptions can come from
 *  contributors). `inline` skips the block wrapper (for a one-line title). */
function Markdown({ source, inline }: { source: string; inline?: boolean }) {
  ensureMdStyles();
  const html = useMemo(() => {
    const raw = inline ? marked.parseInline(source) : marked.parse(source);
    return DOMPurify.sanitize(typeof raw === "string" ? raw : "");
  }, [source, inline]);
  return (
    <div
      className={inline ? "pm-md pm-md-inline" : "pm-md"}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: output is sanitized by DOMPurify above.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** Dockview panel: the PR title + description (the first column). */
function DescriptionPanel(_props: IDockviewPanelProps) {
  const { review } = useReviewCtx();
  return (
    <Box style={{ height: "100%", overflowY: "auto", background: "#1a1b1e" }} px="md" py={10}>
      <Box style={{ fontWeight: 600, fontSize: 15, color: "#e9ecef" }}>
        <Markdown source={review.title} inline />
      </Box>
      <Text size="xs" c="dimmed" mt={2} mb={10}>
        #{review.number} · {review.state}
      </Text>
      {review.body ? (
        <Markdown source={review.body} />
      ) : (
        <Text size="xs" c="dimmed" fs="italic">
          No description.
        </Text>
      )}
    </Box>
  );
}

/** The @pierre/trees file tree column (inside the Files panel). Selecting a file
 *  scrolls the diff to it. */
function FileTreeColumn() {
  const { review, viewed, scrollToFile } = useReviewCtx();
  const files = review.files;
  const [query, setQuery] = useState("");
  // Keep the select handler current without re-creating the tree model each render.
  const selectRef = useRef(scrollToFile);
  selectRef.current = scrollToFile;
  const pathsKey = files.map((f) => f.filename).join("\n");
  // Per-file ±counts for the tree row badges (static — set when the model is built).
  const counts = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of files) m.set(f.filename, `+${f.additions} −${f.deletions}`);
    return m;
  }, [files]);
  const countsRef = useRef(counts);
  countsRef.current = counts;
  // biome-ignore lint/correctness/useExhaustiveDependencies: rebuild the model only when the file set changes, not on every parent render.
  const options = useMemo(
    () => ({
      paths: files.map((f) => f.filename),
      gitStatus: files.map((f) => ({ path: f.filename, status: mapGitStatus(f.status) })),
      initialExpansion: "open" as const,
      flattenEmptyDirectories: true,
      stickyFolders: true,
      fileTreeSearchMode: "hide-non-matches" as const,
      onSelectionChange: (paths: readonly string[]) => {
        if (paths[0]) selectRef.current(paths[0]);
      },
      // A ±count badge on each file row (read off a ref so it survives model reuse).
      renderRowDecoration: (ctx: { item: { kind: string; path: string } }) =>
        ctx.item.kind === "file" ? { text: countsRef.current.get(ctx.item.path) ?? "" } : null,
    }),
    [pathsKey],
  );
  const { model } = useFileTree(options);
  return (
    <Box
      style={{
        width: 250,
        flexShrink: 0,
        borderRight: "1px solid #2c2e33",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      <Group justify="space-between" px="md" py={6} style={{ flexShrink: 0 }}>
        <Text size="xs" c="dimmed" fw={700} style={{ letterSpacing: 0.5 }}>
          FILES
        </Text>
        <Text size="xs" c="dimmed">
          {viewed.size}/{files.length} viewed
        </Text>
      </Group>
      <Box px="sm" pb={6} style={{ flexShrink: 0 }}>
        <TextInput
          size="xs"
          placeholder="Filter files…"
          value={query}
          onChange={(e) => {
            const v = e.currentTarget.value;
            setQuery(v);
            model.setSearch(v || null);
          }}
        />
      </Box>
      <Box style={{ flex: 1, minHeight: 0, ...TREE_VARS }}>
        <FileTree model={model} style={{ height: "100%" }} />
      </Box>
    </Box>
  );
}

/** The scrollable diff column (inside the Files panel): one FileBlock per file. */
function DiffColumn() {
  const { review, registerFileEl } = useReviewCtx();
  return (
    <Box style={{ flex: 1, overflowY: "auto", minWidth: 0 }} px="sm" py={4}>
      {review.files.length === 0 ? (
        <Text c="dimmed" size="sm" px="sm" py="lg">
          No files in this PR.
        </Text>
      ) : (
        <Stack gap="sm">
          {review.files.map((file) => (
            <Box
              key={file.filename}
              ref={(el: HTMLDivElement | null) => registerFileEl(file.filename, el)}
            >
              <FileBlock file={file} />
            </Box>
          ))}
        </Stack>
      )}
    </Box>
  );
}

/** Dockview panel: the file tree + diff together (the second, wider column). */
function FilesPanel(_props: IDockviewPanelProps) {
  return (
    <Box style={{ height: "100%", display: "flex", background: "#1a1b1e" }}>
      <FileTreeColumn />
      <DiffColumn />
    </Box>
  );
}

// The two panels inside the review overlay's own dockview. The operator can drag /
// resize / re-tab them; the layout is rebuilt fresh each time the overlay opens.
const REVIEW_DOCK = { desc: DescriptionPanel, filesdiff: FilesPanel };

// Default: Description on the left (~1/3), the Files (tree + diff) panel filling the
// rest (~2/3). Sized after creation off the dockview width.
function buildReviewLayout(event: DockviewReadyEvent) {
  const api = event.api;
  api.addPanel({ id: "desc", component: "desc", title: "Description" });
  api.addPanel({
    id: "filesdiff",
    component: "filesdiff",
    title: "Diff",
    position: { direction: "right", referencePanel: "desc" },
  });
  const w = api.width || window.innerWidth;
  api.getPanel("desc")?.api.setSize({ width: Math.round(w / 3) });
}

export function ReviewPane({ number, onClose }: { number: number; onClose?: () => void }) {
  const [review, setReview] = useState<PrReview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"unified" | "split">("unified");
  const [posting, setPosting] = useState(false);
  // The line currently being commented on: `${path}::${side}::${line}`, plus the
  // resolved anchor so we know what to draft.
  const [compose, setCompose] = useState<{ key: string; path: string; anchor: LineAnchor } | null>(
    null,
  );
  // The pending review: drafted inline comments + an overall summary, held locally
  // and sent as ONE GitHub review on submit (one event, not one-per-comment).
  const [draft, setDraft] = useState<DraftComment[]>([]);
  const [summary, setSummary] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const nextId = useRef(1);
  // Per-file "viewed" state (GitHub's mechanic), persisted per PR+head so it
  // survives a reload. The diff collapses a viewed file; the sidebar shows the count.
  const [viewed, setViewed] = useState<Set<string>>(new Set());
  const viewedKey = review ? `pm-review-viewed:${number}:${review.headSha}` : null;
  // Scroll-to-file: each file's wrapper registers here, the tree scrolls to it.
  const fileEls = useRef(new Map<string, HTMLDivElement>());
  const scrollToFile = (path: string) =>
    fileEls.current.get(path)?.scrollIntoView({ block: "start", behavior: "smooth" });

  // Load persisted viewed state once the PR (and its head sha) is known.
  useEffect(() => {
    if (!viewedKey) return;
    try {
      const raw = localStorage.getItem(viewedKey);
      setViewed(new Set(raw ? (JSON.parse(raw) as string[]) : []));
    } catch {
      setViewed(new Set());
    }
  }, [viewedKey]);

  const toggleViewed = (path: string) =>
    setViewed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      if (viewedKey) {
        try {
          localStorage.setItem(viewedKey, JSON.stringify([...next]));
        } catch {}
      }
      return next;
    });

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

  // Index drafts by line anchor so each line can show its pending comments.
  const draftByKey = useMemo(() => {
    const m = new Map<string, DraftComment[]>();
    for (const d of draft) {
      const k = keyOf(d.path, { side: d.side, line: d.line });
      const list = m.get(k) ?? [];
      list.push(d);
      m.set(k, list);
    }
    return m;
  }, [draft]);

  const addDraft = (body: string, anchor: LineAnchor, path: string) => {
    if (!body.trim()) return;
    setDraft((d) => [
      ...d,
      { id: nextId.current++, path, line: anchor.line, side: anchor.side, body },
    ]);
    setCompose(null);
  };
  const removeDraft = (id: number) => setDraft((d) => d.filter((x) => x.id !== id));

  // A reply to an existing thread posts immediately (the reviews API can't express
  // replies); fresh line comments are batched into the pending review instead.
  const reply = async (body: string, anchor: LineAnchor, path: string, inReplyTo: number) => {
    if (!review) return;
    setPosting(true);
    try {
      const { error } = await api.prs({ number }).comments.post({
        body,
        commitId: review.headSha,
        path,
        line: anchor.line,
        side: anchor.side,
        inReplyTo,
      });
      if (error) {
        setError(String((error.value as { error?: string })?.error ?? error.status));
        return;
      }
      await load();
    } finally {
      setPosting(false);
    }
  };

  // Submit the whole pending review in one call: every draft comment + the verdict.
  const submit = async (event: ReviewEvent) => {
    if (!review) return;
    setSubmitting(true);
    setError(null);
    try {
      const { error } = await api.prs({ number })["review-submit"].post({
        event,
        body: summary,
        commitId: review.headSha,
        comments: draft.map(({ path, line, side, body }) => ({ path, line, side, body })),
      });
      if (error) {
        setError(String((error.value as { error?: string })?.error ?? error.status));
        return;
      }
      setDraft([]);
      setSummary("");
      await load(); // the submitted comments now come back as posted threads
    } finally {
      setSubmitting(false);
    }
  };

  // Everything the dockview panels (Description, Files) need, rebuilt each render so
  // the portaled panels re-render as state changes. null until the PR has loaded.
  const ctx: ReviewCtxValue | null = review
    ? {
        review,
        view,
        draftByKey,
        removeDraft,
        composeKey: compose?.key ?? null,
        onAdd: (path, anchor) => setCompose({ key: keyOf(path, anchor), path, anchor }),
        onCancelCompose: () => setCompose(null),
        onSubmitCompose: (body) => {
          if (compose) addDraft(body, compose.anchor, compose.path);
        },
        onReply: (inReplyTo, body) => {
          // A reply re-uses the parent's anchor only for the (unused) line/side; the
          // server ignores them when in_reply_to is set.
          const parent = review.comments.find((c) => c.id === inReplyTo);
          const anchor: LineAnchor = { side: parent?.side ?? "RIGHT", line: parent?.line ?? 1 };
          return reply(body, anchor, parent?.path ?? "", inReplyTo);
        },
        posting,
        viewed,
        toggleViewed,
        registerFileEl: (path, el) => {
          if (el) fileEls.current.set(path, el);
          else fileEls.current.delete(path);
        },
        scrollToFile,
      }
    : null;

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
          {onClose && (
            <Button
              size="compact-xs"
              variant="subtle"
              color="gray"
              onClick={onClose}
              title="Close review (Esc)"
            >
              ✕ Close
            </Button>
          )}
        </Group>
      </Group>

      {error && (
        <Text c="red" size="sm" px="md" py="xs" style={{ flex: "0 0 auto" }}>
          {error}
        </Text>
      )}

      {/* The overlay hosts its OWN dockview — Description (1/3) + Files=tree+diff
          (2/3) — so the operator can drag/resize/re-tab the review surface. */}
      {!ctx ? (
        <Box style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Text c="dimmed" size="sm">
            {loading ? "Loading diff…" : "No PR loaded."}
          </Text>
        </Box>
      ) : (
        <ReviewCtx.Provider value={ctx}>
          <Box style={{ flex: 1, minHeight: 0 }}>
            <DockviewReact
              components={REVIEW_DOCK}
              onReady={buildReviewLayout}
              theme={themeAbyss}
            />
          </Box>
          <ReviewBar
            draft={draft}
            summary={summary}
            setSummary={setSummary}
            submit={submit}
            submitting={submitting}
          />
        </ReviewCtx.Provider>
      )}
    </Box>
  );
}

/** The sticky footer that submits the whole pending review at once — a summary plus
 *  Approve / Request changes / Comment. One GitHub review, so a watching session
 *  sees a single event instead of one per comment. */
function ReviewBar({
  draft,
  summary,
  setSummary,
  submit,
  submitting,
}: {
  draft: DraftComment[];
  summary: string;
  setSummary: (s: string) => void;
  submit: (event: ReviewEvent) => Promise<void>;
  submitting: boolean;
}) {
  const [open, setOpen] = useState(false);
  const n = draft.length;
  return (
    <Box style={{ flex: "0 0 auto", borderTop: "1px solid #2c2e33", background: "#202225" }}>
      <Group justify="space-between" px="md" py={8} wrap="nowrap">
        <Text size="xs" c="dimmed">
          {n === 0 ? "No pending comments" : `${n} pending comment${n === 1 ? "" : "s"}`}
        </Text>
        <Button
          size="xs"
          variant={open ? "light" : "filled"}
          color="blue"
          onClick={() => setOpen((o) => !o)}
          rightSection={
            n > 0 ? (
              <Badge size="xs" circle variant="white" color="blue">
                {n}
              </Badge>
            ) : undefined
          }
        >
          {open ? "Hide review" : "Finish review"}
        </Button>
      </Group>
      {open && (
        <Box px="md" pb={8}>
          <Textarea
            autosize
            minRows={2}
            size="xs"
            placeholder="Review summary (required to request changes)…"
            value={summary}
            onChange={(e) => setSummary(e.currentTarget.value)}
          />
          <Group gap={6} mt={6}>
            <Button
              size="compact-xs"
              color="green"
              loading={submitting}
              onClick={() => submit("APPROVE")}
            >
              Approve
            </Button>
            <Button
              size="compact-xs"
              color="red"
              variant="light"
              loading={submitting}
              onClick={() => submit("REQUEST_CHANGES")}
            >
              Request changes
            </Button>
            <Button
              size="compact-xs"
              variant="light"
              color="blue"
              loading={submitting}
              onClick={() => submit("COMMENT")}
            >
              Comment
            </Button>
          </Group>
        </Box>
      )}
    </Box>
  );
}
