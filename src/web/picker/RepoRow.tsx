import { Badge, Group, Text, UnstyledButton } from "@mantine/core";
import type { PickerRepo } from "../../server/repo-picker.ts";

// One row of the picker list: slug + description, with the source's metadata on
// the right (stars for search results, a private badge for your own repos) and
// an "added" badge once the repo is in the registry.

export function RepoRow({
  repo,
  added,
  pickable,
  selected,
  cursor,
  onClick,
  refFn,
}: {
  repo: PickerRepo;
  added: boolean;
  /** Added rows stay pickable when the picker is populating a window. */
  pickable: boolean;
  selected: boolean;
  cursor: boolean;
  onClick: () => void;
  refFn: (el: HTMLButtonElement | null) => void;
}) {
  return (
    <UnstyledButton
      ref={refFn}
      onClick={onClick}
      disabled={!pickable}
      px="sm"
      py="tight"
      style={{
        borderRadius: 4,
        background: selected ? "var(--pm-selection)" : undefined,
        outline: cursor ? "1px solid var(--pm-accent)" : undefined,
        outlineOffset: -1,
        opacity: added && !selected ? 0.55 : 1,
      }}
    >
      <Group gap="sm" wrap="nowrap" justify="space-between">
        <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
          <Text size="sm" fw={600} style={{ whiteSpace: "nowrap" }}>
            {repo.slug}
          </Text>
          <Text size="xs" c="dimmed" truncate>
            {repo.description}
          </Text>
        </Group>
        <Group gap="tight" wrap="nowrap">
          {repo.stars != null && (
            <Text size="xs" c="dimmed">
              ★ {repo.stars}
            </Text>
          )}
          {repo.visibility === "private" && (
            <Badge size="xs" variant="outline" color="gray">
              private
            </Badge>
          )}
          {added && (
            <Badge size="xs" variant="light">
              added
            </Badge>
          )}
        </Group>
      </Group>
    </UnstyledButton>
  );
}
