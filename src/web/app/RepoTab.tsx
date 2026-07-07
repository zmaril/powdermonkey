import { ActionIcon, Group } from "@mantine/core";
import { IconX } from "@tabler/icons-react";
import type { Repo } from "../../server/schema.ts";
import { RepoBadge } from "../plan-ui";

/** One repo tab on the window's tab strip: identity badge + a remove x. */
export function RepoTab({ repo, onRemove }: { repo: Repo; onRemove: () => void }) {
  return (
    <Group
      gap="tight"
      wrap="nowrap"
      px="xs"
      py="hair"
      style={{
        border: "1px solid var(--pm-hairline)",
        borderRadius: "var(--mantine-radius-xl)",
        flexShrink: 0,
      }}
    >
      <RepoBadge repo={repo} />
      <ActionIcon
        size="xs"
        variant="subtle"
        color="gray"
        onClick={onRemove}
        aria-label={`Remove ${repo.slug} from this window`}
      >
        <IconX size={11} />
      </ActionIcon>
    </Group>
  );
}
