import {
  Badge,
  Button,
  Group,
  Loader,
  Modal,
  ScrollArea,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
  UnstyledButton,
} from "@mantine/core";
import { useLiveQuery } from "@tanstack/react-db";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PickerRepo } from "../../server/repo-picker.ts";
import { api } from "../client.ts";
import { reposCollection } from "../collections.ts";
import { useStore } from "../store.ts";

// The Blender-style repo picker (docs/vocabulary.md § Repo): a centered,
// keyboard-first overlay for adding repos to the flat registry. Two sources —
// your own gh repos (fetched once per open, filtered as you type) and a public
// GitHub search (debounced) — rendered as one multi-select list. Confirm POSTs
// each picked slug to /repos/register, which is fork-first: a repo you can't
// push to is forked and YOUR FORK is registered (upstream recorded), so the
// result may live under a different slug than the one you picked — that's shown
// in place before the modal closes. Registered rows stream back over /sync into
// the repos collection, so everything else updates on its own.

const MINE = "mine";
const SEARCH = "search";

type AddOutcome = { forked: string[] } | null;

export function RepoPickerModal() {
  const opened = useStore((s) => s.repoPicker);
  const close = useStore((s) => s.closeRepoPicker);
  return (
    <Modal
      opened={opened}
      onClose={close}
      title="Add repos"
      size="lg"
      centered
      // Fresh state per open (source, query, selection) — cheapest as a remount.
      keepMounted={false}
    >
      {opened && <PickerBody close={close} />}
    </Modal>
  );
}

function PickerBody({ close }: { close: () => void }) {
  const [source, setSource] = useState(MINE);
  const [query, setQuery] = useState("");
  const [mine, setMine] = useState<PickerRepo[] | null>(null);
  const [searched, setSearched] = useState<PickerRepo[]>([]);
  const [searching, setSearching] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<AddOutcome>(null);

  // Already-registered slugs (and the upstreams of forks we made) — shown as
  // "added" and excluded from selection. Live off the synced repos collection.
  const repoRows = useLiveQuery(() => reposCollection);
  const registered = useMemo(() => {
    const s = new Set<string>();
    for (const r of repoRows.data ?? []) {
      if (r.archivedAt != null) continue;
      s.add(r.slug);
      if (r.upstream) s.add(r.upstream);
    }
    return s;
  }, [repoRows.data]);

  // Your repos: one fetch per open.
  useEffect(() => {
    let dead = false;
    (async () => {
      const { data, error } = await api.gh.repos.get();
      if (dead) return;
      if (error || !data || !data.ok) {
        setLoadError(pickerErr(error?.value, "could not list your repos"));
        setMine([]);
        return;
      }
      setMine(data.repos);
    })();
    return () => {
      dead = true;
    };
  }, []);

  // Public search: debounced on the query while the Search source is active.
  useEffect(() => {
    if (source !== SEARCH) return;
    const q = query.trim();
    if (!q) {
      setSearched([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(async () => {
      const { data, error } = await api.gh.search.get({ query: { q } });
      setSearching(false);
      if (error || !data || !data.ok) {
        setLoadError(pickerErr(error?.value, "search failed"));
        return;
      }
      setLoadError(null);
      setSearched(data.repos);
    }, 300);
    return () => clearTimeout(timer);
  }, [source, query]);

  const rows = useMemo(() => {
    if (source === SEARCH) return searched;
    const q = query.trim().toLowerCase();
    const all = mine ?? [];
    if (!q) return all;
    return all.filter(
      (r) => r.slug.toLowerCase().includes(q) || r.description.toLowerCase().includes(q),
    );
  }, [source, query, mine, searched]);

  // Keep the keyboard cursor on the list as it changes under the query.
  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, rows.length - 1)));
  }, [rows.length]);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const toggle = (slug: string) => {
    if (registered.has(slug)) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  };

  const move = (delta: number) => {
    const next = Math.min(Math.max(active + delta, 0), Math.max(0, rows.length - 1));
    setActive(next);
    itemRefs.current[next]?.scrollIntoView({ block: "nearest" });
  };

  const add = async () => {
    const slugs = [...selected].filter((s) => !registered.has(s));
    if (slugs.length === 0) return;
    setBusy(true);
    setAddError(null);
    const forked: string[] = [];
    for (const slug of slugs) {
      const { data, error } = await api.repos.register.post({ slug });
      if (error || !data || !data.ok) {
        setBusy(false);
        setAddError(`${slug}: ${pickerErr(error?.value, "registration failed")}`);
        return;
      }
      if (data.forked) forked.push(`${slug} → ${data.repo.slug}`);
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
          {mine == null && source === MINE && (
            <Group gap="sm" p="sm">
              <Loader size="xs" />
              <Text size="sm" c="dimmed">
                listing your repos…
              </Text>
            </Group>
          )}
          {searching && (
            <Group gap="sm" p="sm">
              <Loader size="xs" />
              <Text size="sm" c="dimmed">
                searching…
              </Text>
            </Group>
          )}
          {rows.map((r, i) => (
            <RepoRow
              key={r.slug}
              repo={r}
              added={registered.has(r.slug)}
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
          Repos you can’t push to are forked — your fork is registered, upstream tracked.
        </Text>
        <Button onClick={add} loading={busy} disabled={selected.size === 0}>
          Add {selected.size > 0 ? selected.size : ""} {selected.size === 1 ? "repo" : "repos"}
        </Button>
      </Group>
    </Stack>
  );
}

function RepoRow({
  repo,
  added,
  selected,
  cursor,
  onClick,
  refFn,
}: {
  repo: PickerRepo;
  added: boolean;
  selected: boolean;
  cursor: boolean;
  onClick: () => void;
  refFn: (el: HTMLButtonElement | null) => void;
}) {
  return (
    <UnstyledButton
      ref={refFn}
      onClick={onClick}
      disabled={added}
      px="sm"
      py="tight"
      style={{
        borderRadius: 4,
        background: selected ? "var(--pm-selection)" : undefined,
        outline: cursor ? "1px solid var(--pm-accent)" : undefined,
        outlineOffset: -1,
        opacity: added ? 0.55 : 1,
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

/** The human message out of a picker route's error body (`{ ok:false, error }`). */
function pickerErr(value: unknown, fallback: string): string {
  if (value && typeof value === "object" && "error" in value) {
    return String((value as { error: unknown }).error);
  }
  return fallback;
}
