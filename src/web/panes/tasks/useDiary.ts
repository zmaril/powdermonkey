import { useLiveQuery } from "@tanstack/react-db";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import type { TaskComment } from "../../../server/schema.ts";
import { taskCommentsCollection } from "../../collections.ts";

// The diary's hooks: the live comment list, the optimistic-echo ledger, and the
// `c` jump-to-composer key. TaskDiary (the component) stays pure render on top of
// these.

/** Sort key: the diary reads oldest→newest, ties broken by insertion order. */
const byTime = (a: TaskComment, b: TaskComment) =>
  new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() || a.id - b.id;

/** One task's live (non-archived) comments, chronological, off the synced
 *  collection. The collection streams every row including archived ones — the
 *  filter here is what makes archiving take effect instantly. */
export function useTaskComments(taskId: number): TaskComment[] {
  const all = useLiveQuery(() => taskCommentsCollection);
  return useMemo(
    () => (all.data ?? []).filter((c) => c.taskId === taskId && c.archivedAt == null).sort(byTime),
    [all.data, taskId],
  );
}

/** An optimistic echo: a line shown the instant Enter is hit, swapped out once the
 *  real row streams back over sync. `realId` arrives when the POST resolves. */
export type PendingLine = { key: number; body: string; at: Date; realId?: number };

/** The optimistic-echo ledger. `track` registers an echo the moment Enter is hit;
 *  `settle` stamps it with the created row's id once the POST resolves; `drop`
 *  removes it on failure. The effect reconciles against the synced list: when a
 *  settled echo's real row has streamed in, the echo retires — the synced row now
 *  renders it. */
export function usePendingLines(comments: TaskComment[]) {
  const [pending, setPending] = useState<PendingLine[]>([]);
  const seq = useRef(0);

  const ids = useMemo(() => new Set(comments.map((c) => c.id)), [comments]);
  useEffect(() => {
    setPending((p) => p.filter((x) => x.realId == null || !ids.has(x.realId)));
  }, [ids]);

  const track = (body: string): number => {
    const key = ++seq.current;
    setPending((p) => [...p, { key, body, at: new Date() }]);
    return key;
  };
  const settle = (key: number, realId: number) =>
    setPending((p) => p.map((x) => (x.key === key ? { ...x, realId } : x)));
  const drop = (key: number) => setPending((p) => p.filter((x) => x.key !== key));

  return { pending, track, settle, drop };
}

/** Pressing `c` with the composer's card under the pointer jumps focus to the
 *  composer — from anywhere that isn't already an editable target. */
export function useComposerJumpKey(inputRef: RefObject<HTMLInputElement | null>) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "c" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const el = inputRef.current;
      if (!el?.closest("[data-pm-card]")?.matches(":hover")) return;
      e.preventDefault();
      el.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inputRef]);
}
