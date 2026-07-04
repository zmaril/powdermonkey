import { Anchor, Badge, Box, Checkbox, Group, Text, UnstyledButton } from "@mantine/core";
import { IconChevronDown } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { reasonLabel } from "../../../server/generated.ts";
import type { ReviewFile } from "../../../server/pr-review.ts";
import { api } from "../../client.ts";
import { useReviewCtx } from "./context.ts";
import { FilePatch } from "./FilePatch.tsx";
import { estimateHeight } from "./helpers.ts";
import { LazyMount } from "./LazyMount.tsx";

/** One file in the diff list: our header (caret · name · status · +/- · Viewed) over
 *  the PatchDiff. Two independent ways to collapse the diff body: the caret (a pure
 *  UI fold that leaves "viewed" untouched) and the Viewed checkbox (GitHub's mechanic
 *  — marking viewed also folds). They share one `collapsed` state: toggling Viewed
 *  syncs it (check → fold, uncheck → unfold), but the caret only ever flips the fold,
 *  never the viewed flag — so you can collapse a file without claiming you reviewed it,
 *  or peek at a viewed file without un-viewing it. A generated/vendored file (lockfile,
 *  bundle, …) starts folded by default, with its reason shown in the header. */
export function FileBlock({ file }: { file: ReviewFile }) {
  const { review, viewed, toggleViewed } = useReviewCtx();
  const isViewed = viewed.has(file.filename);
  // The diff body's fold. Driven by the caret directly and by Viewed via the effect
  // below; the caret never writes back to `viewed`, keeping the two states separate.
  // A generated file starts folded.
  const [collapsed, setCollapsed] = useState(file.generated);
  // Marking a file viewed folds it; un-viewing unfolds it — except a generated file,
  // which falls back to its folded-by-default. (Fires on mount too, once the async
  // viewed state arrives.) A manual caret toggle in between wins until the next viewed
  // change, since this only fires when isViewed (or the generated flag) does.
  useEffect(() => {
    setCollapsed(isViewed || file.generated);
  }, [isViewed, file.generated]);
  // Full-file contents for context expansion, fetched on demand (see #2). null =
  // patch-only (light). Switching on pulls the blob and re-renders via MultiFileDiff.
  const [contents, setContents] = useState<{ oldText: string; newText: string } | null>(null);
  const [loadingContents, setLoadingContents] = useState(false);

  const toggleExpand = async () => {
    if (contents) {
      setContents(null); // back to patch-only
      return;
    }
    setLoadingContents(true);
    try {
      const { data, error } = await api.prs({ number: review.number }).file.get({
        query: { path: file.filename, base: review.baseSha, head: review.headSha },
      });
      if (!error && data) setContents(data as { oldText: string; newText: string });
    } finally {
      setLoadingContents(false);
    }
  };

  return (
    <Box style={{ border: "1px solid var(--pm-hairline)", borderRadius: 6, overflow: "hidden" }}>
      <Group justify="space-between" px="sm" py="snug" style={{ background: "var(--pm-surface)" }}>
        <Group gap="cozy" wrap="nowrap" style={{ minWidth: 0 }}>
          <UnstyledButton
            onClick={() => setCollapsed((c) => !c)}
            title={collapsed ? "Expand file" : "Collapse file"}
            aria-label={collapsed ? "Expand file" : "Collapse file"}
            aria-expanded={!collapsed}
            style={{
              display: "flex",
              alignItems: "center",
              flexShrink: 0,
              color: "var(--pm-dim-text)",
            }}
          >
            <IconChevronDown
              size={14}
              className="pm-rotate"
              style={{ transform: collapsed ? "rotate(-90deg)" : "none" }}
            />
          </UnstyledButton>
          <Text size="sm" ff="monospace" truncate>
            {file.previousFilename ? `${file.previousFilename} → ` : ""}
            {file.filename}
          </Text>
          <Badge size="xs" variant="light" color="gray">
            {file.status}
          </Badge>
          {file.generated && file.generatedReason && (
            <Badge
              size="xs"
              variant="light"
              color="yellow"
              title="Generated/vendored — collapsed by default"
            >
              {reasonLabel(file.generatedReason)}
            </Badge>
          )}
        </Group>
        <Group gap="xs" wrap="nowrap">
          <Text size="xs" c="green">
            +{file.additions}
          </Text>
          <Text size="xs" c="red">
            -{file.deletions}
          </Text>
          {!collapsed && file.patch && (
            <Anchor
              component="button"
              size="xs"
              c="dimmed"
              onClick={toggleExpand}
              title="Fetch the full file to expand collapsed context"
            >
              {loadingContents ? "…" : contents ? "Patch only" : "Expand context"}
            </Anchor>
          )}
          <Checkbox
            size="xs"
            label="Viewed"
            checked={isViewed}
            onChange={() => toggleViewed(file.filename)}
            styles={{
              label: { fontSize: "0.6875rem", color: "var(--pm-dim-text)", paddingLeft: 6 },
            }}
          />
        </Group>
      </Group>
      {!collapsed &&
        (file.patch ? (
          <LazyMount estimate={estimateHeight(file.patch)}>
            <FilePatch file={file} contents={contents} />
          </LazyMount>
        ) : (
          <Text size="xs" c="dimmed" px="md" py="sm">
            No textual diff (binary, rename, or too large to display).
          </Text>
        ))}
    </Box>
  );
}
