import {
  Button,
  Group,
  Loader,
  ScrollArea,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { useMemo, useState } from "react";
import { api } from "../client.ts";
import { useStore } from "../store.ts";
import { RepoRow } from "./RepoRow.tsx";
import {
  MINE,
  pickerErr,
  SEARCH,
  useListCursor,
  usePickerSources,
  useRegistry,
} from "./use-picker.ts";

// The picker's working surface (see RepoPickerModal.tsx for the overall model):
// source switch + query box over one multi-select list, arrow-key cursor with
// Enter-to-toggle, and the confirm that registers picks fork-first. After an add
// where fork-first renamed something, the picked → registered mapping is shown
// in place (the `outcome` branch) before the modal closes.

type AddOutcome = { forked: string[] } | null;

export function PickerBody({
  close,
  forWindowId,
}: {
  close: () => void;
  forWindowId: string | null;
}) {
  const [source, setSource] = useState(MINE);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<AddOutcome>(null);

  const { bySlug, registered } = useRegistry();
  const { mine, searched, searching, loadError } = usePickerSources(source, query);

  const rows = useMemo(() => {
    if (source === SEARCH) return searched;
    const q = query.trim().toLowerCase();
    const all = mine ?? [];
    if (!q) return all;
    return all.filter(
      (r) => r.slug.toLowerCase().includes(q) || r.description.toLowerCase().includes(q),
    );
  }, [source, query, mine, searched]);

  const { active, setActive, move, itemRefs } = useListCursor(rows.length);

  const toggle = (slug: string) => {
    // Unscoped, an already-registered row is inert; scoped to a window it's still
    // a valid pick (it just becomes a tab without re-registering).
    if (forWindowId == null && registered.has(slug)) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  };

  const add = async () => {
    if (selected.size === 0) return;
    setBusy(true);
    setAddError(null);
    const forked: string[] = [];
    const ids: number[] = [];
    for (const slug of selected) {
      // Already in the registry (directly or as the upstream of our fork): no
      // gh work, just carry its id — a scoped pick adds it as a tab below.
      const existing = bySlug.get(slug);
      if (existing) {
        ids.push(existing.id);
        continue;
      }
      const { data, error } = await api.repos.register.post({ slug });
      if (error || !data || !data.ok) {
        setBusy(false);
        setAddError(`${slug}: ${pickerErr(error?.value, "registration failed")}`);
        return;
      }
      ids.push(data.repo.id);
      if (data.forked) forked.push(`${slug} → ${data.repo.slug}`);
    }
    // The populate-a-window intent (Ctrl+N / the rail's +): the picked repos —
    // fresh registrations and existing rows alike — become the window's tabs.
    if (forWindowId != null) {
      const s = useStore.getState();
      const win = s.windows.find((w) => w.id === forWindowId);
      if (win) s.setWindowRepos(forWindowId, [...new Set([...win.repoIds, ...ids])]);
    }
    setBusy(false);
    setSelected(new Set());
    // Fork-first changed the slug on some of them — show that before closing;
    // a plain add just closes (the new rows are already streaming into the UI).
    if (forked.length > 0) setOutcome({ forked });
    else close();
  };

  if (outcome) {
    return (
      <Stack gap="sm">
        <Text size="sm">Added, fork-first — these were registered as your fork:</Text>
        {outcome.forked.map((line) => (
          <Text key={line} size="sm" ff="monospace">
            {line}
          </Text>
        ))}
        <Group justify="flex-end">
          <Button onClick={close}>Done</Button>
        </Group>
      </Stack>
    );
  }

  const loading =
    mine == null && source === MINE ? "listing your repos…" : searching ? "searching…" : null;

  return (
    <Stack gap="sm">
      <Group gap="sm" wrap="nowrap">
        <TextInput
          data-autofocus
          style={{ flex: 1 }}
          placeholder={source === SEARCH ? "Search public GitHub repos…" : "Filter your repos…"}
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              move(1);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              move(-1);
            } else if (e.key === "Enter" && rows[active]) {
              e.preventDefault();
              toggle(rows[active].slug);
            }
          }}
        />
        <SegmentedControl
          value={source}
          onChange={setSource}
          data={[
            { label: "Your repos", value: MINE },
            { label: "Search GitHub", value: SEARCH },
          ]}
        />
      </Group>

      <ScrollArea.Autosize mah="45vh" type="auto">
        <Stack gap={0}>
          {loading && (
            <Group gap="sm" p="sm">
              <Loader size="xs" />
              <Text size="sm" c="dimmed">
                {loading}
              </Text>
            </Group>
          )}
          {rows.map((r, i) => (
            <RepoRow
              key={r.slug}
              repo={r}
              added={registered.has(r.slug)}
              pickable={forWindowId != null || !registered.has(r.slug)}
              selected={selected.has(r.slug)}
              cursor={i === active}
              refFn={(el) => {
                itemRefs.current[i] = el;
              }}
              onClick={() => {
                setActive(i);
                toggle(r.slug);
              }}
            />
          ))}
          {rows.length === 0 && mine != null && !searching && (
            <Text size="sm" c="dimmed" p="sm">
              {source === SEARCH
                ? query.trim()
                  ? "no matches"
                  : "type to search public repos"
                : "no repos"}
            </Text>
          )}
        </Stack>
      </ScrollArea.Autosize>

      {(loadError || addError) && (
        <Text size="xs" c="red">
          {addError ?? loadError}
        </Text>
      )}

      <Group justify="space-between" align="center">
        <Text size="xs" c="dimmed">
          {forWindowId != null
            ? "Picked repos become this window’s tabs; ones you can’t push to are forked first."
            : "Repos you can’t push to are forked — your fork is registered, upstream tracked."}
        </Text>
        <Button onClick={add} loading={busy} disabled={selected.size === 0}>
          Add {selected.size > 0 ? selected.size : ""} {selected.size === 1 ? "repo" : "repos"}
        </Button>
      </Group>
    </Stack>
  );
}
