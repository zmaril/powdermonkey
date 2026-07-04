import { useEffect, useRef, useState } from "react";

/** Reveal a slot only once it scrolls near the viewport (once; stays shown). Returns
 *  the ref to attach and whether to render the real content. Lets a many-file PR skip
 *  running every file's highlight up front. */
export function useInView() {
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
  return { ref, show };
}
