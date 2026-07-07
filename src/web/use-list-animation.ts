import { useAutoAnimate } from "@formkit/auto-animate/react";
import { useCallback, useEffect, useRef } from "react";
import { listAnimationDuration, motionOption } from "./motion.ts";
import { useStore } from "./store.ts";

// List add/remove/reorder animation (auto-animate handles enter/leave/FLIP and skips
// the initial mount) — wired to the motion setting so it eases at the motion-scaled
// duration and switches off entirely when motion is Off. The one place auto-animate is
// configured, so the motion control reaches the lists like everything else.
//
// Returns `[ref, suspend]`. `suspend(true)` pauses the animation regardless of motion
// (e.g. while a card swaps to its inline editor, where a morph would be jarring);
// `suspend(false)` resumes — but only if motion is on. So the effective enabled state is
// `motion-on AND not-suspended`, and the two concerns never fight.
export function useListAnimation() {
  const motion = useStore((s) => s.motion);
  const motionOn = motionOption(motion).factor > 0;
  const [ref, setEnabled] = useAutoAnimate({ duration: listAnimationDuration(motion) });
  const suspended = useRef(false);
  // Re-apply whenever motion flips; `suspended` (caller-driven) is read live.
  useEffect(() => {
    setEnabled(motionOn && !suspended.current);
  }, [motionOn, setEnabled]);
  const suspend = useCallback(
    (on: boolean) => {
      suspended.current = on;
      setEnabled(motionOn && !on);
    },
    [motionOn, setEnabled],
  );
  return [ref, suspend] as const;
}
