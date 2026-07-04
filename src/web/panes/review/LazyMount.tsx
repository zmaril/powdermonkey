import type { ReactNode } from "react";
import { useInView } from "./use-in-view.ts";

/** Mount `children` only once the slot scrolls near the viewport, so a many-file PR
 *  doesn't run every file's Shiki highlight up front — the practical win of
 *  virtualization without rewriting onto CodeView. A height-estimate placeholder
 *  keeps the scrollbar roughly stable; once shown it stays mounted (so comment/
 *  composer state isn't lost on scroll). */
export function LazyMount({ estimate, children }: { estimate: number; children: ReactNode }) {
  const { ref, show } = useInView();
  return <div ref={ref}>{show ? children : <div style={{ height: estimate }} />}</div>;
}
