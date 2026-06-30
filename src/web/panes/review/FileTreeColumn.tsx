import { Box, Group, Text, TextInput } from "@mantine/core";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { type CSSProperties, useMemo, useRef, useState } from "react";
import { useReviewCtx } from "./context.ts";
import { mapGitStatus } from "./helpers.ts";

// Theme the @pierre/trees shadow-DOM tree to match the app's dark panes. The tree's
// base colours default to a light theme, so set the full `--trees-*-override` set
// (custom properties pierce the shadow boundary, so the host is enough) — leaving
// only some overridden makes the tree render mostly white.
const TREE_VARS: CSSProperties = {
  background: "var(--pm-pane-bg)",
  "--trees-bg-override": "var(--pm-pane-bg)",
  "--trees-bg-muted-override": "var(--pm-surface)",
  "--trees-fg-override": "var(--pm-text)",
  "--trees-fg-muted-override": "var(--pm-dim-text)",
  "--trees-border-color-override": "var(--pm-hairline)",
  "--trees-accent-override": "var(--pm-accent)",
  "--trees-selected-bg-override": "var(--pm-surface)",
  "--trees-selected-fg-override": "var(--pm-text)",
  "--trees-selected-focused-border-color-override": "var(--pm-accent)",
  "--trees-indent-guide-bg-override": "var(--pm-hairline)",
  "--trees-scrollbar-thumb-override": "var(--pm-scroll-thumb)",
  "--trees-focus-ring-color-override": "var(--pm-accent)",
} as CSSProperties;

/** The @pierre/trees file tree column (inside the Files panel). Selecting a file
 *  scrolls the diff to it. */
export function FileTreeColumn() {
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
        borderRight: "1px solid var(--pm-hairline)",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      <Group justify="space-between" px="md" py="snug" style={{ flexShrink: 0 }}>
        <Text size="xs" c="dimmed" fw={700} style={{ letterSpacing: 0.5 }}>
          FILES
        </Text>
        <Text size="xs" c="dimmed">
          {viewed.size}/{files.length} viewed
        </Text>
      </Group>
      <Box px="sm" pb="snug" style={{ flexShrink: 0 }}>
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
