import { Box } from "@mantine/core";
import type { DiffLineAnnotation } from "@pierre/diffs/react";
import { MultiFileDiff, PatchDiff } from "@pierre/diffs/react";
import { useMemo } from "react";
import type { ReviewFile } from "../../../server/pr-review.ts";
import { Composer } from "./Composer.tsx";
import { PendingCard } from "./PendingCard.tsx";
import { Thread } from "./Thread.tsx";
import { useReviewCtx } from "./context.ts";
import { DIFF_THEME, fromASide, indexComments, keyOf, parseKey, toASide } from "./helpers.ts";
import type { ASide, AnnMeta, Side } from "./types.ts";

/** One file's diff, rendered by @pierre/diffs' PatchDiff (Shiki highlighting,
 *  split/unified, virtualized) from the raw GitHub patch. Inline comment threads,
 *  pending drafts, and the composer are injected via its annotation framework; the
 *  gutter "+" opens the composer for a line. */
export function FilePatch({
  file,
  contents,
}: {
  file: ReviewFile;
  contents?: { oldText: string; newText: string } | null;
}) {
  const {
    review,
    view,
    draftByKey,
    removeDraft,
    composeKey,
    composeStartLine,
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
      <Box
        style={{
          borderTop: "1px solid var(--pm-hairline)",
          borderBottom: "1px solid var(--pm-hairline)",
        }}
      >
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
          <Composer
            onSubmit={onSubmitCompose}
            onCancel={onCancelCompose}
            posting={posting}
            hint={
              composeStartLine != null && composeStartLine !== line
                ? `Commenting on lines ${Math.min(composeStartLine, line)}–${Math.max(composeStartLine, line)}`
                : undefined
            }
          />
        )}
      </Box>
    );
  };

  // Open the composer for a line. The gutter "+" and line-number click route here.
  const addAt = (side: ASide | undefined, line: number) =>
    onAdd(file.filename, { side: fromASide(side ?? "additions"), line });

  // Shared across both renderers (both are DiffBasePropsReact). With full contents
  // we render MultiFileDiff (which can expand collapsed context); otherwise the
  // lighter PatchDiff off the raw patch.
  const common = {
    disableWorkerPool: true,
    lineAnnotations: annotations,
    renderAnnotation,
    options: {
      diffStyle: (view === "split" ? "split" : "unified") as "split" | "unified",
      theme: DIFF_THEME,
      themeType: "dark" as const,
      disableFileHeader: true,
      enableGutterUtility: true,
      enableLineSelection: true,
      // The hover "+" in the gutter — passes the clicked line/side directly.
      onGutterUtilityClick: (range: { start: number; side?: ASide }) =>
        addAt(range.side, range.start),
      // Clicking a line number also starts a comment (reliable, GitHub-like).
      onLineNumberClick: (props: { lineNumber: number; annotationSide?: ASide }) =>
        addAt(props.annotationSide, props.lineNumber),
      // Drag-selecting lines → comment on the whole range (GitHub anchors at the end
      // line; we pass the start as start_line). A single-line selection is a normal
      // line comment.
      onLineSelectionEnd: (
        range: { start: number; end: number; side?: ASide; endSide?: ASide } | null,
      ) => {
        if (!range) return;
        const endLine = Math.max(range.start, range.end);
        const startLine = Math.min(range.start, range.end);
        onAdd(
          file.filename,
          { side: fromASide(range.endSide ?? range.side ?? "additions"), line: endLine },
          startLine !== endLine ? startLine : undefined,
        );
      },
    },
  };

  return contents ? (
    <MultiFileDiff<AnnMeta>
      oldFile={{ name: file.filename, contents: contents.oldText }}
      newFile={{ name: file.filename, contents: contents.newText }}
      {...common}
    />
  ) : (
    <PatchDiff<AnnMeta> patch={file.patch} {...common} />
  );
}
