import { useEffect, useRef } from "react";

// The composer's reply-seed effect, lifted out of the component so the effect lives in a
// hook (the same discipline as usePolled / useConnectionWatch) rather than the component
// body. A "Reply" click on a mail card mints a fresh `token` (Date.now) every time, so the
// value identity — not the body — is what re-fires the seed: clicking Reply twice on the
// same card re-seeds even with identical text.

/** Fire `seed` once per new reply `token`. `seed` must be stable (define it with
 *  useCallback), since it's an effect dependency; the token guard makes a same-token
 *  re-render a no-op, so it only runs when a genuinely new reply arrives. */
export function useReplySeed<T extends { token: number }>(
  reply: T | null | undefined,
  seed: (reply: T) => void,
): void {
  const seededToken = useRef<number | null>(null);
  useEffect(() => {
    if (!reply || reply.token === seededToken.current) return;
    seededToken.current = reply.token;
    seed(reply);
  }, [reply, seed]);
}
