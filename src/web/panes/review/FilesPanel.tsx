import { Box } from "@mantine/core";
import type { IDockviewPanelProps } from "dockview-react";
import { DiffColumn } from "./DiffColumn.tsx";
import { FileTreeColumn } from "./FileTreeColumn.tsx";

/** Dockview panel: the file tree + diff together (the second, wider column). */
export function FilesPanel(_props: IDockviewPanelProps) {
  return (
    <Box style={{ height: "100%", display: "flex", background: "var(--pm-pane-bg)" }}>
      <FileTreeColumn />
      <DiffColumn />
    </Box>
  );
}
