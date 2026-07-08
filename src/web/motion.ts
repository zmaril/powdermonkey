// The motion axis: a fourth user-controlled appearance setting, independent of theme /
// density / font. ALL animation in the app is defined in one place — motion.css for the
// CSS (transitions, keyframes) and this file for the durations/easing — and keyed off a
// single setting so it can be softened or switched off entirely. Components never write
// ad-hoc transitions; that.s enforced by straitjacket (motion rule).
//
// How the setting reaches everything:
//   • Our own transitions/keyframes (motion.css) read the `--pm-dur-*` variables this
//     module sets — scaled by the motion factor (0 when off → instant).
//   • Third-party animation (Mantine popovers, dockview) doesn't use our vars, so when
//     motion is "off" motion.css also applies a global kill-switch keyed on the
//     `data-pm-motion` attribute set here.
//   • The OS "reduce motion" preference is always honored (a media query in motion.css).

export type MotionOption = { key: string; label: string; factor: number };

// Base durations (ms) at factor 1. Tweak here to retune motion app-wide.
const BASE = { fast: 120, base: 200, slow: 300, pulse: 1600 };

export const MOTION: MotionOption[] = [
  { key: "full", label: "Full", factor: 1 },
  { key: "subtle", label: "Subtle", factor: 0.6 },
  { key: "off", label: "Off", factor: 0 }, // lint-allow-string: motion preference key, not SyncMode.Off
];

export const DEFAULT_MOTION = "full";

export function motionOption(key: string): MotionOption {
  return (
    MOTION.find((o) => o.key === key) ??
    (MOTION.find((o) => o.key === DEFAULT_MOTION) as MotionOption)
  );
}

/** Duration (ms) for the list add/remove/reorder animation (auto-animate), scaled by
 *  the motion factor — 0 disables it. */
export function listAnimationDuration(key: string): number {
  return Math.round(300 * motionOption(key).factor);
}

/** Push the motion durations onto the document as `--pm-dur-*` variables and stamp the
 *  `data-pm-motion` attribute (motion.css uses it for the "off" kill-switch). */
export function applyMotionVars(key: string): void {
  const f = motionOption(key).factor;
  const s = document.documentElement.style;
  s.setProperty("--pm-dur-fast", `${Math.round(BASE.fast * f)}ms`);
  s.setProperty("--pm-dur-base", `${Math.round(BASE.base * f)}ms`);
  s.setProperty("--pm-dur-slow", `${Math.round(BASE.slow * f)}ms`);
  s.setProperty("--pm-dur-pulse", `${Math.round(BASE.pulse * f)}ms`);
  s.setProperty("--pm-ease", "ease");
  document.documentElement.dataset.pmMotion = key;
}
