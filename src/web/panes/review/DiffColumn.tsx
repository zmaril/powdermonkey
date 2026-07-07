import { Box, Stack, Text } from "@mantine/core";
import { useReviewCtx } from "./context.ts";
import { FileBlock } from "./FileBlock.tsx";

/** The scrollable diff column (inside the Files panel): one FileBlock per file. */
export function DiffColumn() {
  const { review, registerFileEl } = useReviewCtx();
  return (
    <Box style={{ flex: 1, overflowY: "auto", minWidth: 0 }} px="sm" py="tight">
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
