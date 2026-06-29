import { type ReactNode, useEffect, useRef, useState } from "react";

/** Mount `children` only once the slot scrolls near the viewport, so a many-file PR
 *  doesn't run every file's Shiki highlight up front — the practical win of
 *  virtualization without rewriting onto CodeView. A height-estimate placeholder
 *  keeps the scrollbar roughly stable; once shown it stays mounted (so comment/
 *  composer state isn't lost on scroll). */
export function LazyMount({ estimate, children }: { estimate: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (show) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShow(true);
          io.disconnect();
        }
      },
      { rootMargin: "800px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [show]);
  return <div ref={ref}>{show ? children : <div style={{ height: estimate }} />}</div>;
}
