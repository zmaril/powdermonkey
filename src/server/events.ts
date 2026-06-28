// A tiny in-process typed event bus. One GitHub watcher (github-watch.ts) emits;
// independent subscribers (the prUrl enricher, the reconcile trigger, …) react.
// No queue, no framework — single process, single PGlite writer, so "fan-out" is
// just awaiting the registered handlers in turn. Keeping the bus domain-free is
// the whole point: the watcher knows GitHub, the handlers know tasks/sessions,
// and neither side imports the other.

import type { CheckRollupState, MergeableState, PrState } from "../shared/types.ts";

/** A pull request a cloud worker opened for a task (branch `pm/task-<id>-<slug>`),
 *  reduced to the fields the supervisor reacts to. */
export type CloudPr = {
  taskId: number;
  number: number;
  url: string;
  state: PrState;
  isDraft: boolean;
  merged: boolean;
  /** statusCheckRollup state (SUCCESS / FAILURE / PENDING / …), or null when the
   *  head commit has no checks configured. */
  checks: CheckRollupState | null;
  /** Whether GitHub can merge this PR cleanly: MERGEABLE / CONFLICTING / UNKNOWN
   *  (GitHub computes it lazily, so UNKNOWN just means "not yet"), or null. */
  mergeable: MergeableState | null;
  headRefName: string;
  updatedAt: string;
};

// `initial` marks events from the startup catch-up sync — PRs that already
// existed before the supervisor booted — rather than a change observed live.
// Idempotent handlers ignore it; a notification-style handler should skip when
// it's true so a restart doesn't ping the operator about week-old PRs.
export type CloudEventMeta = { initial: boolean };

export type CloudEvents = {
  "pr.opened": CloudPr;
  "pr.updated": CloudPr;
  "pr.merged": CloudPr;
  "pr.closed": CloudPr; // closed without merging
};

// biome-ignore lint/suspicious/noExplicitAny: handler set is keyed per-event; the on/emit signatures keep callers type-safe.
type Handler<T> = (payload: T, meta: CloudEventMeta) => any;

class Bus {
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous handler sets, one per event key.
  #handlers = new Map<keyof CloudEvents, Set<Handler<any>>>();

  /** Subscribe; returns an unsubscribe fn. A `[[github-watch]]` event seam — call
   *  this from anywhere to add a new reaction without touching the watcher. */
  on<K extends keyof CloudEvents>(event: K, handler: Handler<CloudEvents[K]>): () => void {
    const set = this.#handlers.get(event) ?? new Set();
    this.#handlers.set(event, set);
    set.add(handler);
    return () => set.delete(handler);
  }

  /** Emit to every subscriber, awaiting each. A throwing handler is logged and
   *  skipped — one bad subscriber can't break the loop or the others. */
  async emit<K extends keyof CloudEvents>(
    event: K,
    payload: CloudEvents[K],
    meta: CloudEventMeta,
  ): Promise<void> {
    const set = this.#handlers.get(event);
    if (!set) return;
    for (const h of set) {
      try {
        await h(payload, meta);
      } catch (e) {
        console.warn(`bus handler for ${event} failed:`, e instanceof Error ? e.message : e);
      }
    }
  }
}

export const bus = new Bus();
