import { Box, Group, SegmentedControl, Stack, Text } from "@mantine/core";
import type { DockviewPanelApi } from "dockview-react";
import { useLayoutEffect, useRef, useState } from "react";
import { TaskStatus } from "../../../shared/types.ts";
import { partitionTasks } from "../../active.ts";
import { usePaneScroll } from "../../pane-scroll.ts";
import { usePlanData } from "../../plan-data.ts";
import { FlatView } from "./FlatView.tsx";
import { GoalGroup } from "./GoalGroup.tsx";
import { SelectionBar } from "./SelectionBar.tsx";
import { StartPanel } from "./StartPanel.tsx";
import type { Selection, View } from "./types.ts";

// The Backlog pane is the launchpad — everything to-be-worked (not active),
// grouped goal → milestone as cards (or one flat star-first list). Every card
// carries the same action cluster (TaskActions): launch it 💻/☁️ or close it
// (DONE / WONTDO). Shift-click a card to add it to a multi-selection; while a
// selection is live the per-card actions hide and one batch bar drives the whole
// set as ONE launch — so it's clear they move together. Goals and milestones have
// carets to collapse them.

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
 *  render — the anchor must be current at the instant a star lands. */
function usePreserveScrollAcrossResort(scrollRef: React.RefObject<HTMLDivElement | null>) {
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
    if (!scroller) return;
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
}

export function BacklogPane({ api }: { api?: DockviewPanelApi }) {
  const { idx, activeIds, loading } = usePlanData();
  const [view, setView] = useState<View>("grouped");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const scroll = usePaneScroll("backlog", api);
  usePreserveScrollAcrossResort(scroll.ref);

  // Backlog = everything to-be-worked: not active (no live session) and not merged.
  const allTasks = [...idx.tasksByMilestone.values()].flat();
  const { backlog: backlogList } = partitionTasks(allTasks, activeIds);
  const backlogTasks = backlogList.filter((t) => t.status !== TaskStatus.Merged);
  const backlog = new Set(backlogTasks.map((t) => t.id));
  const goals = [...idx.goals].sort((a, b) => a.id - b.id);

  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const selection: Selection = { selected, toggle, active: selected.size > 0 };

  // The launch order is the rendered backlog order (goal → milestone → position),
  // so the first selected card becomes the primary task of the shared session. Drop
  // any selected ids that are no longer in the backlog (e.g. just launched).
  const selectedIds = backlogTasks.map((t) => t.id).filter((id) => selected.has(id));

  return (
    <Box
      style={{ height: "100%", display: "flex", flexDirection: "column", background: "#1a1b1e" }}
    >
      <Group justify="space-between" px="md" py={8} style={{ flex: "0 0 auto" }}>
        <Group gap={8}>
          <Text size="xs" c="dimmed" fw={700} style={{ letterSpacing: 0.5 }}>
            BACKLOG
          </Text>
          {loading && (
            <Text size="xs" c="dimmed">
              loading…
            </Text>
          )}
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

      <Box
        ref={scroll.ref}
        onScroll={scroll.onScroll}
        // overflowAnchor none: when starring re-sorts the list, the browser's own scroll
        // anchoring chases the card that floated to the top and yanks the whole list up
        // to it (scrollTop → 0), losing your place. Turn it off so a re-sort leaves the
        // scroll where it is; usePreserveScrollAcrossResort then holds your exact spot.
        // position relative anchors contentTop's offset walk (see the helper).
        style={{ flex: 1, overflowY: "auto", overflowAnchor: "none", position: "relative" }}
        px={view === "grouped" ? "md" : 0}
        py={4}
      >
        <Box px={view === "grouped" ? 0 : "md"}>
          <StartPanel />
        </Box>
        {goals.length === 0 ? (
          <Text c="dimmed" size="sm" px="md" py="lg">
            No plan loaded. POST one to /plan.
          </Text>
        ) : view === "flat" ? (
          backlogTasks.length === 0 ? (
            <Text c="dimmed" size="sm" px="md" py="lg">
              Backlog is empty — every task is active or done.
            </Text>
          ) : (
            <FlatView tasks={backlogTasks} idx={idx} selection={selection} />
          )
        ) : (
          <Stack gap="xl">
            {goals.map((g) => (
              <GoalGroup key={g.id} goal={g} idx={idx} backlog={backlog} selection={selection} />
            ))}
          </Stack>
        )}
      </Box>

      {selectedIds.length > 0 && (
        <SelectionBar ids={selectedIds} clear={() => setSelected(new Set())} />
      )}
    </Box>
  );
}
