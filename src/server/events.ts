// A tiny in-process typed event bus. One GitHub watcher (github-watch.ts) emits;
// independent subscribers (the prUrl enricher, the reconcile trigger, …) react.
// No queue, no framework — single process, single PGlite writer, so "fan-out" is
// just awaiting the registered handlers in turn. Keeping the bus domain-free is
// the whole point: the watcher knows GitHub, the handlers know tasks/sessions,
// and neither side imports the other.

import type { AgentState, CheckRollupState, MergeableState, PrState } from "../shared/types.ts";

/** The agent-authored status, parsed from the newest `<!-- pm:status -->`-marked comment
 *  a cloud worker posts on its PR — append-only, a fresh marked comment per update (see
 *  the powdermonkey skill). `state` is the
 *  structured signal the UI drives logic from (blocked → needs-you); `body` is the
 *  raw comment so the panel can show the worker's own narrative, not just the parsed
 *  fields. Persisted alongside the rest of the PR state in the pull_requests table. */
export type AgentStatus = {
  /** The parsed lifecycle state (AgentState), or null when the marker is present but
   *  the `status:` word is missing or isn't one we recognise — the worker authors it
   *  as free text, so the parser is the validation seam. The raw line still rides in
   *  `body`, so an unrecognised status is shown to the operator even with no chip. */
  state: AgentState | null;
  summary: string | null;
  next: string | null;
  /** A link to the cloud session that authored this comment — the `claude.ai/code/…`
   *  URL the worker stamps (the same one the harness puts in its `Claude-Session:`
   *  commit trailer). Maps a status comment straight to its session without going
   *  through the branch/trailer task resolution — and stays unambiguous if several
   *  agents ever post status comments on one PR. Null when the worker didn't stamp it. */
  sessionUrl: string | null;
  /** The full status comment body with the marker line stripped — the human-readable
   *  glance at what the agent thinks is happening. */
  body: string;
  /** When GitHub last saw the comment edited — a freshness hint, or null. */
  updatedAt: string | null;
};

/** A pull request a cloud worker opened for a task (branch `pm/task-<id>-<slug>`),
 *  reduced to the fields the supervisor reacts to. */
export type CloudPr = {
  taskId: number;
  number: number;
  title: string;
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
  /** The worker's self-reported status, parsed from its newest `<!-- pm:status -->`-marked
   *  comment, or null when it hasn't posted one (or the marker can't be found). */
  agent: AgentStatus | null;
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
