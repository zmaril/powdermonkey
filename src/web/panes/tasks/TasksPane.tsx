import { closestCorners, DndContext, DragOverlay } from "@dnd-kit/core";
import type { ComboboxData } from "@mantine/core";
import { Box, Card, Group, SegmentedControl, Stack, Text } from "@mantine/core";
import type { DockviewPanelApi } from "dockview-react";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { usePaneScroll } from "../../pane-scroll.ts";
import { useFullData, useProposalEdits, useProposalGhosts } from "../../plan-data.ts";
import { FilterBar } from "../FilterBar.tsx";
import {
  ANY,
  DEFAULT_TASK_FILTER,
  matchTask,
  parseScope,
  scopeOptions,
  scopeValue,
  TaskBucket,
  type TaskFilter,
} from "../filters.ts";
import { useWindow } from "../use-window.ts";
import { FlatView } from "./FlatView.tsx";
import { GoalGroup } from "./GoalGroup.tsx";
import { HighlightProvider, useNewTaskReveal } from "./new-task.ts";
import { useBacklogReorder } from "./reorder.ts";
import { ScrollIndicator } from "./ScrollIndicator.tsx";
import { SelectionBar } from "./SelectionBar.tsx";
import { StartPanel } from "./StartPanel.tsx";
import type { Selection, View } from "./types.ts";

// The task lifecycle buckets the operator filters on (default Backlog). Done/archived
// are buckets now, not a separate tab. Values are the TaskBucket consts, not literals.
const STATUS_DATA: ComboboxData = [
  { value: ANY, label: "Any status" },
  { value: TaskBucket.Backlog, label: "Backlog" },
  { value: TaskBucket.Active, label: "Active" },
  { value: TaskBucket.Finished, label: "Done" },
  { value: TaskBucket.WontDo, label: "Won't do" },
  { value: TaskBucket.Archived, label: "Archived" },
];

// The Tasks pane is the one filterable list of EVERY task — backlog, active,
// done/merged, cancelled, archived — not just the to-be-worked set the old Backlog
// showed. It keeps the launchpad's machinery: tasks grouped goal → milestone as cards
// (or one flat star-first list), each carrying the same action cluster (TaskActions):
// launch it local/remote or close it (DONE / WONTDO). Shift-click a card to add it to a
// multi-selection; while a selection is live the per-card actions hide and one batch bar
// drives the whole set as ONE launch. Goals and milestones have carets to collapse them.
// (The card components keep their historical Backlog* names.) A search + filter strip
// (FilterBar) slices the list; it opens to backlog (DEFAULT_TASK_FILTER) so the pane comes
// up like the old Backlog, and widens to active/done/cancelled/archived on demand.

/** A card's top within the scroll content — summed offsets up to the scroller. This is
 *  scroll-invariant AND transform-invariant (offsetTop ignores the transforms
 *  auto-animate applies while a re-sort is in flight), so it reads a card's true resting
 *  place even mid-animation. The scroller is `position: relative` so the walk ends there. */
function contentTop(node: HTMLElement, scroller: HTMLElement): number {
  let y = 0;
  let el: HTMLElement | null = node;
  while (el && el !== scroller && scroller.contains(el)) {
    y += el.offsetTop;
    el = el.offsetParent as HTMLElement | null;
  }
  return y;
}

/** The topmost card still on screen (across every group) and how far below the top edge
 *  it sits — the thing the operator is looking at, expressed scroll-invariantly so we
 *  can put it back. Cards carry `data-pm-card` (their task id) as the handle. */
function topAnchor(scroller: HTMLElement): { key: string; offset: number } | null {
  const top = scroller.scrollTop;
  let best: HTMLElement | null = null;
  let bestTop = Number.POSITIVE_INFINITY;
  for (const node of scroller.querySelectorAll<HTMLElement>("[data-pm-card]")) {
    const ct = contentTop(node, scroller);
    if (ct + node.offsetHeight <= top + 1) continue; // scrolled above the top edge
    if (ct < bestTop) {
      bestTop = ct;
      best = node;
    }
  }
  return best ? { key: best.dataset.pmCard ?? "", offset: contentTop(best, scroller) - top } : null;
}

/** Keep your place across a star-driven re-sort. With the browser's scroll anchoring off
 *  (see the scroll Box), a re-sort leaves scrollTop alone but still shifts the content —
 *  the card you were reading slides as the starred card floats above it. So we hold it:
 *  track the topmost on-screen card as you scroll, and after a re-sort put it back at the
 *  same offset by nudging scrollTop. The re-sort then slides the other cards around your
 *  anchor instead of moving you. It's scroll math, not animation, so it holds with motion
 *  off too. We track on `scroll` (not just on render) because scrolling fires no React
 *  render — the anchor must be current at the instant a star lands.
 *
 *  Also the single owner of *deliberate* scrolls (revealing a new card, jumping to one
 *  off-screen): those go through `revealCard`, which scrolls the card in and then re-reads
 *  the anchor synchronously, so the very next restore is a no-op instead of yanking you
 *  back to where you were before the reveal. */
function usePreserveScrollAcrossResort(
  scrollRef: React.RefObject<HTMLDivElement | null>,
  // Paused while a drag is in flight: a reorder shifts cards every frame on purpose, and
  // re-anchoring the scroll to a moving card would fight the drag. We leave the scroll
  // alone during the drag and let the post-drop render settle it.
  paused = false,
) {
  const anchor = useRef<{ key: string; offset: number } | null>(null);

  // Keep the anchor fresh as the operator scrolls.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const track = () => {
      anchor.current = topAnchor(scroller);
    };
    track();
    scroller.addEventListener("scroll", track, { passive: true });
    return () => scroller.removeEventListener("scroll", track);
  }, [scrollRef]);

  // After every render — including a re-sort — restore the anchor card to its remembered
  // offset, then refresh the anchor from the settled position. When nothing moved this is
  // a no-op (it resolves to the current scrollTop); when a star re-sorted, it undoes the
  // shift.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || paused) return;
    const a = anchor.current;
    if (a) {
      const sel = `[data-pm-card="${a.key.replace(/["\\]/g, "\\$&")}"]`;
      const node = scroller.querySelector<HTMLElement>(sel);
      if (node) {
        const want = contentTop(node, scroller) - a.offset;
        if (Math.abs(scroller.scrollTop - want) > 0.5) scroller.scrollTop = want;
      }
    }
    anchor.current = topAnchor(scroller);
  });

  // Scroll a card into view by its task id, then re-anchor on it so the resort preserver
  // (above) treats the new position as the place to hold — otherwise its next restore would
  // immediately undo the reveal. Instant, not smooth: a deliberate jump shouldn't fight the
  // anchor math mid-animation, and the glow is what draws the eye. Returns false if the card
  // isn't in the DOM yet (its row hasn't streamed in / isn't within the window), so the
  // caller can retry on the next render.
  const revealCard = useCallback(
    (taskId: number): boolean => {
      const scroller = scrollRef.current;
      if (!scroller) return false;
      const node = scroller.querySelector<HTMLElement>(`[data-pm-card="${taskId}"]`);
      if (!node) return false;
      node.scrollIntoView({ block: "nearest" });
      anchor.current = topAnchor(scroller);
      return true;
    },
    [scrollRef],
  );

  return { revealCard };
}

export function TasksPane({ api }: { api?: DockviewPanelApi }) {
  const { idx, activeIds, loading } = useFullData();
  const ghosts = useProposalGhosts();
  const edits = useProposalEdits();
  const reorder = useBacklogReorder(idx);
  const [view, setView] = useState<View>("grouped");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const scroll = usePaneScroll("tasks", api); // lint-allow-string: pane scroll key, not an enum value
  // Pause the scroll re-anchor while a drag is in flight — a reorder shifts cards on
  // purpose every frame, and re-anchoring to a moving card would fight the drag. Also
  // exposes revealCard for the new-task glow/scroll (below).
  const { revealCard } = usePreserveScrollAcrossResort(scroll.ref, reorder.activeId != null);
  // Opens to backlog (DEFAULT_TASK_FILTER) so the pane comes up showing what the old
  // Backlog did; widen the status filter to see active / done / cancelled / archived.
  const [filter, setFilter] = useState<TaskFilter>(DEFAULT_TASK_FILTER);
  const set = (patch: Partial<TaskFilter>) => setFilter((f) => ({ ...f, ...patch }));
  const isDefault = JSON.stringify(filter) === JSON.stringify(DEFAULT_TASK_FILTER);

  // Every task, sliced by the filter, in plan order.
  const allTasks = [...idx.tasksByMilestone.values()].flat();
  // Every live task id — the surface new-task detection diffs against, so a task created by
  // a worker or an accepted proposal counts as new just like one you added, whatever filter
  // is active.
  const allIds = new Set(allTasks.map((t) => t.id));
  const visibleTasks = allTasks.filter((t) => matchTask(t, idx, activeIds, filter));
  const visible = new Set(visibleTasks.map((t) => t.id));
  const goals = [...idx.goals].sort((a, b) => a.id - b.id);
  // The flat view can run long (every task, any status), so window it; the grouped view
  // is already chunked by goal/milestone headers. The full set stays live underneath.
  const win = useWindow(visibleTasks.length, `${view}:${JSON.stringify(filter)}`, scroll.ref);
  const shownTasks = visibleTasks.slice(0, win.limit);

  // The task ids whose cards actually render right now — grouped shows every visible task,
  // flat shows only the windowed slice. This gates the new-task glow/scroll to cards that
  // exist in the DOM and prunes a highlight whose card scrolled out of the window or was
  // filtered away before it was seen.
  const present = useMemo(
    () => (view === "flat" ? new Set(shownTasks.map((t) => t.id)) : visible),
    [view, shownTasks, visible],
  );
  // A stable digest of the rendered ids — changes when a card mounts/unmounts (a new row
  // streams in, the window grows, the filter shifts), so a queued auto-scroll retries and
  // the IntersectionObserver re-attaches at the right moment.
  const idsKey = useMemo(() => [...present].sort((a, b) => a - b).join(","), [present]);
  const { highlighted, hasAbove, hasBelow, jumpAbove, jumpBelow } = useNewTaskReveal(
    scroll.ref,
    idsKey,
    allIds,
    present,
    revealCard,
  );

  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const selection: Selection = { selected, toggle, active: selected.size > 0 };

  // The launch order is the rendered order (goal → milestone → position), so the first
  // selected card becomes the primary task of the shared session. Drop any selected ids
  // no longer visible (e.g. filtered out, or just launched).
  const selectedTasks = visibleTasks.filter((t) => selected.has(t.id));
  const selectedIds = selectedTasks.map((t) => t.id);
  // Cross-repo guard (client twin of the server's): one session runs one repo, so a
  // selection that spans repos can't launch together. A null repo is its own bucket, so
  // mixing a repo-less task with a repo-pinned one counts as cross-repo — same rule as
  // dispatch.spansRepos on the server.
  const crossRepo = new Set(selectedTasks.map((t) => t.repoId ?? null)).size > 1;

  return (
    <HighlightProvider value={highlighted}>
      <Box
        style={{
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background: "var(--pm-pane-bg)",
        }}
      >
        <Stack gap="cozy" px="md" py="cozy" style={{ flex: "0 0 auto" }}>
          <Group justify="space-between">
            <Group gap="cozy">
              <Text size="xs" c="dimmed" fw={700} style={{ letterSpacing: 0.5 }}>
                TASKS
              </Text>
              <Text size="xs" c="dimmed">
                {loading ? "loading…" : `${visibleTasks.length} shown`}
              </Text>
            </Group>
            <SegmentedControl
              size="xs"
              value={view}
              onChange={(v) => setView(v as View)}
              data={[
                { label: "Flat", value: "flat" },
                { label: "Grouped", value: "grouped" },
              ]}
            />
          </Group>
          <FilterBar
            search={filter.search}
            onSearch={(v) => set({ search: v })}
            searchPlaceholder="task id or title"
            statusData={STATUS_DATA}
            status={filter.status}
            onStatus={(v) => set({ status: v as TaskFilter["status"] })}
            env={filter.env}
            onEnv={(v) => set({ env: v as TaskFilter["env"] })}
            scopeData={scopeOptions(idx)}
            scope={scopeValue(filter)}
            onScope={(v) => set(parseScope(v))}
            starred={filter.starred}
            onStarred={(v) => set({ starred: v })}
            onReset={() => setFilter(DEFAULT_TASK_FILTER)}
            isDefault={isDefault}
          />
        </Stack>

        {/* Relative wrapper so the off-screen new-task indicators can pin to the viewport
          edges without scrolling away with the list. */}
        <Box style={{ flex: 1, position: "relative", minHeight: 0, display: "flex" }}>
          <Box
            ref={scroll.ref}
            onScroll={scroll.onScroll}
            data-pm-scroll="tasks" // lint-allow-string: dockview pane id, not an enum value
            // overflowAnchor none: when starring re-sorts the list, the browser's own scroll
            // anchoring chases the card that floated to the top and yanks the whole list up
            // to it (scrollTop → 0), losing your place. Turn it off so a re-sort leaves the
            // scroll where it is; usePreserveScrollAcrossResort then holds your exact spot.
            // position relative anchors contentTop's offset walk (see the helper).
            style={{ flex: 1, overflowY: "auto", overflowAnchor: "none", position: "relative" }}
            px={view === "grouped" ? "md" : 0}
            py="tight"
          >
            <Box px={view === "grouped" ? 0 : "md"}>
              <StartPanel />
            </Box>
            {goals.length === 0 ? (
              <Text c="dimmed" size="sm" px="md" py="lg">
                No plan loaded. POST one to /plan.
              </Text>
            ) : view === "flat" ? (
              visibleTasks.length === 0 ? (
                <Text c="dimmed" size="sm" px="md" py="lg">
                  No tasks match.
                </Text>
              ) : (
                <>
                  <FlatView
                    tasks={shownTasks}
                    idx={idx}
                    selection={selection}
                    ghosts={ghosts}
                    edits={edits}
                  />
                  {win.hasMore && (
                    <div ref={win.sentinelRef}>
                      <Text c="dimmed" size="xs" ta="center" py="sm">
                        loading more… ({shownTasks.length} of {visibleTasks.length})
                      </Text>
                    </div>
                  )}
                </>
              )
            ) : (
              <DndContext
                sensors={reorder.sensors}
                collisionDetection={closestCorners}
                onDragStart={reorder.onDragStart}
                onDragOver={reorder.onDragOver}
                onDragEnd={reorder.onDragEnd}
              >
                <Stack gap="xl">
                  {goals.map((g) => (
                    <GoalGroup
                      key={g.id}
                      goal={g}
                      idx={idx}
                      backlog={visible}
                      selection={selection}
                      ghosts={ghosts}
                      edits={edits}
                      reorder={reorder}
                    />
                  ))}
                </Stack>
                <DragOverlay>
                  {reorder.draggedLabel ? (
                    <Card withBorder radius="md" padding="xs" bg="dark.5" style={{ opacity: 0.95 }}>
                      <Text size="sm" fw={600} truncate>
                        {reorder.draggedLabel}
                      </Text>
                    </Card>
                  ) : null}
                </DragOverlay>
              </DndContext>
            )}
          </Box>
          {hasAbove && <ScrollIndicator dir="up" onClick={jumpAbove} />}
          {hasBelow && <ScrollIndicator dir="down" onClick={jumpBelow} />}
        </Box>

        {selectedIds.length > 0 && (
          <SelectionBar
            ids={selectedIds}
            clear={() => setSelected(new Set())}
            crossRepo={crossRepo}
          />
        )}
      </Box>
    </HighlightProvider>
  );
}
