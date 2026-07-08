import { useLiveQuery } from "@tanstack/react-db";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import type { PickerRepo } from "../../server/repo-picker.ts";
import type { Repo } from "../../server/schema.ts";
import { api } from "../client.ts";
import { reposCollection } from "../collections.ts";

// The picker's stateful plumbing, as hooks (the new-task.ts / useDiary.ts
// pattern): the registry index, the two gh-backed sources, and the keyboard
// cursor. PickerBody composes these; the components stay render-only.

export const MINE = "mine";
export const SEARCH = "search";

/** The human message out of a picker route's error body (`{ ok:false, error }`). */
export function pickerErr(value: unknown, fallback: string): string {
  if (value && typeof value === "object" && "error" in value) {
    return String((value as { error: unknown }).error);
  }
  return fallback;
}

/** The live registry (synced repos collection), keyed by slug AND by the
 *  upstream of forks we made — plus the same keys as a set for "added" badges. */
export function useRegistry(): { bySlug: Map<string, Repo>; registered: Set<string> } {
  const repoRows = useLiveQuery(() => reposCollection);
  const bySlug = useMemo(() => {
    const m = new Map<string, Repo>();
    for (const r of repoRows.data ?? []) {
      if (r.archivedAt != null) continue;
      m.set(r.slug, r);
      if (r.upstream) m.set(r.upstream, r);
    }
    return m;
  }, [repoRows.data]);
  const registered = useMemo(() => new Set(bySlug.keys()), [bySlug]);
  return { bySlug, registered };
}

export type PickerSources = {
  /** Your gh repos; null while the one fetch per open is in flight. */
  mine: PickerRepo[] | null;
  /** Public-search results for the current query (Search source only). */
  searched: PickerRepo[];
  searching: boolean;
  loadError: string | null;
};

/** The two gh-backed sources: your repos (fetched once per mount) and the
 *  public search (debounced on the query while the Search source is active). */
export function usePickerSources(source: string, query: string): PickerSources {
  const [mine, setMine] = useState<PickerRepo[] | null>(null);
  const [searched, setSearched] = useState<PickerRepo[]>([]);
  const [searching, setSearching] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

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

  return { mine, searched, searching, loadError };
}

export type ListCursor = {
  active: number;
  setActive: (i: number) => void;
  /** Move the cursor by delta, clamped, scrolling the row into view. */
  move: (delta: number) => void;
  itemRefs: RefObject<(HTMLButtonElement | null)[]>;
};

/** Keyboard cursor over the visible rows, kept in range as the list changes
 *  under the query. */
export function useListCursor(count: number): ListCursor {
  const [active, setActive] = useState(0);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, count - 1)));
  }, [count]);
  const move = (delta: number) => {
    const next = Math.min(Math.max(active + delta, 0), Math.max(0, count - 1));
    setActive(next);
    itemRefs.current[next]?.scrollIntoView({ block: "nearest" });
  };
  return { active, setActive, move, itemRefs };
}
