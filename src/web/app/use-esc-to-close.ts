import { useEffect } from "react";

/** While `active`, close on Escape — but ignore Esc while typing so it can't eat a
 *  draft in a textarea/input. */
export function useEscToClose(active: unknown, close: () => void) {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t instanceof HTMLTextAreaElement || t instanceof HTMLInputElement;
      if (e.key === "Escape" && !typing) close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, close]);
}
