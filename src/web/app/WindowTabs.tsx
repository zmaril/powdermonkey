import { ActionIcon, Divider, Group, Menu, Text, TextInput, Tooltip } from "@mantine/core";
import { IconPlus, IconX } from "@tabler/icons-react";
import { useLiveQuery } from "@tanstack/react-db";
import { useState } from "react";
import type { Repo } from "../../server/schema.ts";
import { reposCollection } from "../collections.ts";
import { RepoBadge } from "../plan-ui";
import { useActiveWindow, useStore } from "../store.ts";

// The active window's repo tab strip (docs/windows.md): the Firefox-tab analog, one
// chip per repo in the window's working set. The panes show the UNION of these repos
// (the strip is the set's composition, not a one-at-a-time focus) — remove a tab and
// its repo's tasks/sessions leave the view, add one and they stream in. An empty set
// reads "All repos": the window is unscoped. Sits under the TopBar, above the dock —
// window chrome, not pane state, because the scope belongs to the window.

/** The window's optional name: click to edit. Unlike EditableText, an unnamed
 *  window starts the draft EMPTY (the "unnamed" placeholder is a label, not text
 *  you should have to delete), and committing empty clears the name — back to
 *  identified-by-repo-set, like a browser window. */
function WindowName({
  name,
  onSave,
}: {
  name: string | null;
  onSave: (next: string | null) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null); // null = not editing
  if (draft != null) {
    const commit = () => {
      onSave(draft.trim() || null);
      setDraft(null);
    };
    return (
      <TextInput
        size="xs"
        variant="filled"
        autoFocus
        value={draft}
        placeholder="name this window"
        onChange={(e) => setDraft(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") setDraft(null);
        }}
        style={{ width: 140 }}
      />
    );
  }
  return (
    <Text
      size="xs"
      c={name ? undefined : "dimmed"}
      truncate
      title="Click to name this window"
      style={{ cursor: "text", maxWidth: 180 }}
      onClick={() => setDraft(name ?? "")}
    >
      {name ?? "unnamed"}
    </Text>
  );
}

/** One repo tab: identity badge + a remove x. */
function RepoTab({ repo, onRemove }: { repo: Repo; onRemove: () => void }) {
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

export function WindowTabs() {
  const win = useActiveWindow();
  const setWindowRepos = useStore((s) => s.setWindowRepos);
  const renameWindow = useStore((s) => s.renameWindow);
  const repos = useLiveQuery(() => reposCollection);
  if (!win) return null;
  const live = (repos.data ?? []).filter((r) => r.archivedAt == null);
  const byId = new Map(live.map((r) => [r.id, r]));
  // The window's tabs in their stored order; an id whose repo was archived since
  // just drops off the strip (the filter treats it as gone too — it matches nothing).
  const tabs = win.repoIds.map((id) => byId.get(id)).filter((r): r is Repo => r != null);
  const addable = live.filter((r) => !win.repoIds.includes(r.id));

  return (
    <Group
      gap="xs"
      wrap="nowrap"
      px="md"
      py="hair"
      style={{
        flex: "0 0 auto",
        borderBottom: "1px solid var(--pm-hairline)",
        background: "var(--pm-tab-strip)",
        overflowX: "auto",
      }}
    >
      {/* Optional window name (Firefox windows are usually unnamed — the repo set is
          the identity). Click to name/rename; committing empty un-names it. */}
      <div style={{ flexShrink: 0 }}>
        <WindowName name={win.name} onSave={(next) => renameWindow(win.id, next)} />
      </div>
      <Divider orientation="vertical" my="hair" />
      {tabs.length === 0 ? (
        <Tooltip label="This window is unscoped — every repo is in view. Add a repo tab to narrow it.">
          <Text size="xs" c="dimmed">
            All repos
          </Text>
        </Tooltip>
      ) : (
        tabs.map((r) => (
          <RepoTab
            key={r.id}
            repo={r}
            onRemove={() =>
              setWindowRepos(
                win.id,
                win.repoIds.filter((id) => id !== r.id),
              )
            }
          />
        ))
      )}
      {addable.length > 0 && (
        <Menu position="bottom-start" withinPortal>
          <Menu.Target>
            <ActionIcon size="sm" variant="subtle" color="gray" aria-label="Add a repo tab">
              <IconPlus size={13} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Label>Add repo to this window</Menu.Label>
            {addable.map((r) => (
              <Menu.Item key={r.id} onClick={() => setWindowRepos(win.id, [...win.repoIds, r.id])}>
                <RepoBadge repo={r} />
              </Menu.Item>
            ))}
          </Menu.Dropdown>
        </Menu>
      )}
    </Group>
  );
}
