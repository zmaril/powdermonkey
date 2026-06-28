import {
  type CSSProperties,
  Children,
  type ReactElement,
  type ReactNode,
  isValidElement,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

// A light, dependency-free animated list: cards fade/slide IN, ease OUT (collapse +
// fade) instead of popping, and slide between positions when the order changes (the
// FLIP technique). Built for the Backlog pane, where launching a task removes its
// card and starring a task re-sorts the group — both of which would otherwise jump.
//
// The repo has no animation library and the house idiom is hand-rolled CSS guarded by
// prefers-reduced-motion (see TabActivity.tsx), so this stays in that spirit: a small
// wrapper that owns its children's enter/leave/reorder, nothing more. Each child is
// boxed in a wrapper <div> we can transform/collapse without reaching into the child
// (which may be any Mantine component), keyed by the child's own React key.

// Subtle and fast — polish, not flourish. One short duration and one easing for every
// transition so the whole pane moves as a piece.
const DURATION_MS = 170;
const EASING = "cubic-bezier(0.2, 0, 0, 1)";

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Slot a leaving key back into the incoming order near where it last sat, so a card
 *  eased out stays put while it collapses instead of jumping to the end. */
function mergeLeaving(
  incomingKeys: string[],
  leavingKeys: string[],
  prevOrder: string[],
): string[] {
  const result = [...incomingKeys];
  for (const key of leavingKeys) {
    const prevIdx = prevOrder.indexOf(key);
    let insertAt = result.length;
    for (let i = prevIdx - 1; i >= 0; i--) {
      const ri = result.indexOf(prevOrder[i]);
      if (ri !== -1) {
        insertAt = ri + 1;
        break;
      }
      if (i === 0) insertAt = 0;
    }
    result.splice(insertAt, 0, key);
  }
  return result;
}

export function AnimatedList({
  children,
  gap = 0,
  style,
}: {
  children: ReactNode;
  /** Vertical space between items, in px (applied as margin so it collapses on exit). */
  gap?: number;
  style?: CSSProperties;
}) {
  const incoming = Children.toArray(children).filter(isValidElement) as ReactElement[];
  const incomingKeys = incoming.map((c) => String(c.key));
  const incomingByKey = new Map(incoming.map((c) => [String(c.key), c]));

  const containerRef = useRef<HTMLDivElement>(null);
  const tops = useRef<Map<string, number>>(new Map()); // key -> last viewport top, for FLIP
  const entered = useRef<Set<string>>(new Set()); // keys already animated in
  const lastEl = useRef<Map<string, ReactElement>>(new Map()); // newest element per live key
  const leaving = useRef<Map<string, ReactElement>>(new Map()); // retained, mid-exit
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const prevKeys = useRef<string[]>([]);
  const renderOrder = useRef<string[]>([]);
  const mounted = useRef(false);
  const [, force] = useState(0);

  const reduce = prefersReducedMotion();

  // First mount (or a reload): everything is already on screen, so mark it entered —
  // we don't want the whole list to animate in on load, only cards added afterwards.
  if (!mounted.current) {
    for (const k of incomingKeys) entered.current.add(k);
    mounted.current = true;
  }

  // Remember the latest element for every live key, so a key that LATER disappears
  // still has something to render while it eases out.
  for (const c of incoming) lastEl.current.set(String(c.key), c);

  if (!reduce) {
    // A key present last render but gone now is leaving: retain its last element.
    for (const k of prevKeys.current) {
      if (!incomingByKey.has(k) && !leaving.current.has(k)) {
        const el = lastEl.current.get(k);
        if (el) leaving.current.set(k, el);
      }
    }
    // A key that comes back mid-exit cancels its exit.
    for (const k of incomingKeys) {
      if (leaving.current.has(k)) {
        leaving.current.delete(k);
        const t = timers.current.get(k);
        if (t) {
          clearTimeout(t);
          timers.current.delete(k);
        }
      }
    }
  }
  prevKeys.current = incomingKeys;

  const order = reduce
    ? incomingKeys
    : mergeLeaving(incomingKeys, [...leaving.current.keys()], renderOrder.current);
  renderOrder.current = order;

  useLayoutEffect(() => {
    if (reduce) return;
    const container = containerRef.current;
    if (!container) return;
    const nodes = container.querySelectorAll<HTMLElement>(":scope > [data-anim-key]");
    const nextTops = new Map<string, number>();

    for (const node of nodes) {
      const key = node.dataset.animKey;
      if (!key) continue;
      const top = node.getBoundingClientRect().top;
      nextTops.set(key, top);

      // Leaving: collapse height + fade, once, then drop it from state.
      if (leaving.current.has(key)) {
        if (node.dataset.leavingStarted) continue;
        node.dataset.leavingStarted = "1";
        node.style.height = `${node.offsetHeight}px`;
        node.style.overflow = "hidden";
        void node.offsetHeight; // reflow so the height below actually transitions
        node.style.transition = `height ${DURATION_MS}ms ${EASING}, opacity ${DURATION_MS}ms ${EASING}, margin ${DURATION_MS}ms ${EASING}, transform ${DURATION_MS}ms ${EASING}`;
        node.style.height = "0px";
        node.style.marginBottom = "0px";
        node.style.opacity = "0";
        node.style.transform = "scale(0.98)";
        const t = setTimeout(() => {
          leaving.current.delete(key);
          timers.current.delete(key);
          force((n) => n + 1);
        }, DURATION_MS + 20);
        timers.current.set(key, t);
        continue;
      }

      // Entering: paint at 0 (this runs before paint) then animate to rest next frame.
      if (!entered.current.has(key)) {
        entered.current.add(key);
        node.style.transition = "none";
        node.style.opacity = "0";
        node.style.transform = "translateY(-6px)";
        requestAnimationFrame(() => {
          node.style.transition = `opacity ${DURATION_MS}ms ${EASING}, transform ${DURATION_MS}ms ${EASING}`;
          node.style.opacity = "1";
          node.style.transform = "none";
        });
        continue;
      }

      // Reordered: FLIP — jump to the old spot with no transition, then slide to rest.
      const prevTop = tops.current.get(key);
      if (prevTop !== undefined && prevTop !== top) {
        node.style.transition = "none";
        node.style.transform = `translateY(${prevTop - top}px)`;
        requestAnimationFrame(() => {
          node.style.transition = `transform ${DURATION_MS}ms ${EASING}`;
          node.style.transform = "none";
        });
      }
    }

    tops.current = nextTops;
  });

  if (reduce) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap, ...style }}>{incoming}</div>
    );
  }

  return (
    <div ref={containerRef} style={{ display: "flex", flexDirection: "column", ...style }}>
      {order.map((key, i) => {
        const el = incomingByKey.get(key) ?? leaving.current.get(key);
        if (!el) return null;
        // Gap goes BETWEEN items (as collapsible margin), not after the last one, so a
        // group's trailing space stays whatever its parent sets — no doubled gutter
        // before the next milestone header.
        return (
          <div
            key={key}
            data-anim-key={key}
            style={{
              marginBottom: i === order.length - 1 ? 0 : gap,
              willChange: "transform, opacity",
            }}
          >
            {el}
          </div>
        );
      })}
    </div>
  );
}
