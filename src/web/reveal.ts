import type { DockviewApi } from "dockview-react";
import { type RefObject, useEffect, useRef } from "react";
import { beginReveal, endReveal, setPaneScroll } from "./pane-scroll.ts";
import { type Indexes, usePlanData } from "./plan-data.ts";
import type { PmKind } from "./pm-ids.ts";
import { useStore } from "./store.ts";
import { PANE_ACTIVE, PANE_BACKLOG } from "./tab-activity.ts";

// Jump-to-entity: the other half of the terminal PM-id links (pm-id-links.ts). A click
// on a t/p/m/g/s id fires the store's revealEntity, which this hook turns into a real
// navigation — focus the pane the entity lives in (Backlog or Active), scroll it into
// view, and briefly flash it so the eye lands on it. It reuses the pane-scroll infra:
// the panes mark their scroll container with `data-pm-scroll`, every revealable element
// carries a `data-pm-reveal` handle, and the scroll position is recorded through the
// same persistence (and guarded so the saved-offset restore yields while we position).

/** Where a reveal should land: which pane, and the element handle within it. */
export type RevealTarget = { pane: string; selector: string };

/** The `data-pm-reveal` selector for an id token (e.g. "t110" → the task's handle). */
function handle(token: string): string {
  return `[data-pm-reveal="${token}"]`;
}

/** Resolve a clicked id to its pane + element. A task lives in Active when it has a live
 *  session, otherwise the Backlog; goals/milestones are Backlog headers; a session is an
 *  Active worker card. Returns null for a kind we can't place yet. */
export function resolveReveal(
  kind: PmKind,
  id: number,
  idx: Indexes,
  activeIds: Set<number>,
): RevealTarget | null {
  switch (kind) {
    case "g":
      return idx.goalById.has(id) ? { pane: PANE_BACKLOG, selector: handle(`g${id}`) } : null;
    case "m":
      return idx.milestoneById.has(id) ? { pane: PANE_BACKLOG, selector: handle(`m${id}`) } : null;
    case "t": {
      const pane = activeIds.has(id) ? PANE_ACTIVE : PANE_BACKLOG;
      return { pane, selector: handle(`t${id}`) };
    }
    case "s":
      return { pane: PANE_ACTIVE, selector: handle(`s${id}`) };
    default:
      return null;
  }
}

/** Scroll `el` to the vertical centre of its `scroller`, clamped to the scroll range. */
function centerInScroller(el: HTMLElement, scroller: HTMLElement): void {
  const top =
    el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  const target = top - (scroller.clientHeight - el.offsetHeight) / 2;
  const max = scroller.scrollHeight - scroller.clientHeight;
  scroller.scrollTop = Math.max(0, Math.min(target, max));
}

/** Briefly highlight an element. The flash itself is a motion.css animation (so it
 *  respects the motion setting); we just toggle the class — removed first, re-added next
 *  frame so a repeat reveal restarts it — and clear it on animationend (with a timeout
 *  fallback for when motion is off and no animationend fires). */
function flash(el: HTMLElement): void {
  el.classList.remove("pm-flash");
  const clear = () => {
    el.classList.remove("pm-flash");
    el.removeEventListener("animationend", clear);
  };
  requestAnimationFrame(() => {
    el.classList.add("pm-flash");
    el.addEventListener("animationend", clear);
    setTimeout(clear, 1800);
  });
}

// The pane's content streams in / animates over the first frames after it's focused, so
// poll a few frames for the element rather than reading it once.
const REVEAL_FRAMES = 60;

/** Focus the pane and, once its target element is in the DOM, centre + flash it. */
function revealInPane(pane: string, selector: string): void {
  beginReveal(pane);
  let frames = 0;
  const run = () => {
    const el = document.querySelector<HTMLElement>(selector);
    const scroller = el?.closest<HTMLElement>(`[data-pm-scroll="${pane}"]`) ?? null;
    if (el && scroller) {
      centerInScroller(el, scroller);
      // Record where we landed through the same persistence the panes use, so a later
      // tab-away/return restores to the revealed spot instead of the old offset.
      setPaneScroll(pane, scroller.scrollTop);
      flash(el);
      endReveal(pane);
      return;
    }
    if (frames++ < REVEAL_FRAMES) requestAnimationFrame(run);
    else endReveal(pane);
  };
  requestAnimationFrame(run);
}

/** Watch revealEntity requests and drive the jump. Kept in App (it owns the dockview
 *  api); resolution reads the live plan data through a ref so the effect runs only on a
 *  new request, not on every data delta. */
export function useRevealEntity(apiRef: RefObject<DockviewApi | null>): void {
  const req = useStore((s) => s.revealReq);
  const { idx, activeIds } = usePlanData();
  const dataRef = useRef({ idx, activeIds });
  dataRef.current = { idx, activeIds };

  useEffect(() => {
    if (!req) return;
    const target = resolveReveal(req.kind, req.id, dataRef.current.idx, dataRef.current.activeIds);
    if (!target) return;
    const api = apiRef.current;
    const panel = api?.getPanel(target.pane);
    // Bring the pane up: focus it if open, else open it (App's paneReq effect adds it).
    if (panel) panel.api.setActive();
    else useStore.getState().openPane(target.pane);
    revealInPane(target.pane, target.selector);
  }, [req, apiRef]);
}
