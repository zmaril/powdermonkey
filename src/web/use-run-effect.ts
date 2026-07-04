import { useEffect } from "react";

/** Run `fn` on mount and whenever its identity changes — e.g. a memoized loader, or
 *  a store action fetched once. The effect-free way to say "do this when this changes". */
export function useRunEffect(fn: () => void): void {
  useEffect(() => {
    fn();
  }, [fn]);
}
