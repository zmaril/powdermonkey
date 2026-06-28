import type { Phase } from "../server/schema.ts";
import { PhaseStatus } from "../shared/types.ts";

export type Rollup = { done: number; total: number; pct: number };

/** Progress is measured at the Phase grain and rolled up over a set of phases. */
export function rollup(phases: Phase[]): Rollup {
  const total = phases.length;
  const done = phases.filter((p) => p.status === PhaseStatus.Done).length;
  return { done, total, pct: total === 0 ? 0 : Math.round((done / total) * 100) };
}
