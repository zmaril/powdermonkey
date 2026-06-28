import { eq } from "drizzle-orm";
import { db } from "./db.ts";
import type { CloudPr } from "./events.ts";
import { type PullRequestRow, pullRequests } from "./schema.ts";

// Persistence for the PR state github-watch polls. The table mixes a *cache* of
// GitHub state with a *ledger* of the rebase ask (see schema.ts), so the writes
// here are deliberately split: `upsertPrState` only ever touches the cache columns
// (never `rebaseAskedAt`), and the ledger has its own mark/clear helpers. Keeping
// those write paths separate is what lets the poll churn the row every tick without
// ever clobbering the fact that we already asked @claude to rebase.

/** Reconstruct the in-memory `CloudPr` shape the watcher and UI speak. The DB's
 *  `ghUpdatedAt` maps back to CloudPr's `updatedAt` (GitHub's PR timestamp). */
function rowToCloudPr(r: PullRequestRow): CloudPr {
  return {
    taskId: r.taskId ?? 0,
    number: r.number,
    title: r.title,
    url: r.url,
    state: r.state,
    isDraft: r.isDraft,
    merged: r.merged,
    checks: r.checks,
    mergeable: r.mergeable,
    headRefName: r.headRefName,
    updatedAt: r.ghUpdatedAt,
    // `agentBody` is written for every status comment (even a bare one), so its
    // presence is the "has a status comment" signal — null means no comment yet.
    agent:
      r.agentBody == null
        ? null
        : {
            state: r.agentState,
            summary: r.agentSummary,
            next: r.agentNext,
            body: r.agentBody,
            updatedAt: r.agentUpdatedAt,
          },
  };
}

/** Every persisted PR (unordered) — backs GET /cloud-prs so the UI shows last-known
 *  PR state immediately on boot, before the first poll lands. The UI keys by task
 *  and picks the right PR per task itself, so order here doesn't matter. */
export async function listPrs(): Promise<CloudPr[]> {
  const rows = await db.select().from(pullRequests);
  return rows.map(rowToCloudPr);
}

/** Upsert the observed GitHub state for one PR. Pointedly omits `rebaseAskedAt`
 *  from both the insert and the conflict update: the poll must never disturb the
 *  ask ledger — only the helpers below write that column. */
export async function upsertPrState(pr: CloudPr): Promise<void> {
  const state = {
    taskId: pr.taskId,
    title: pr.title,
    url: pr.url,
    state: pr.state,
    isDraft: pr.isDraft,
    merged: pr.merged,
    checks: pr.checks,
    mergeable: pr.mergeable,
    headRefName: pr.headRefName,
    ghUpdatedAt: pr.updatedAt,
    // Agent status: cache columns like the rest, written from the parsed sticky
    // comment (null across the board when the PR has no status comment).
    agentState: pr.agent?.state ?? null,
    agentSummary: pr.agent?.summary ?? null,
    agentNext: pr.agent?.next ?? null,
    agentBody: pr.agent?.body ?? null,
    agentUpdatedAt: pr.agent?.updatedAt ?? null,
    updatedAt: new Date(),
  };
  await db
    .insert(pullRequests)
    .values({ number: pr.number, ...state })
    .onConflictDoUpdate({ target: pullRequests.number, set: state });
}

/** Has this PR already been asked to rebase its current conflict episode? Reads the
 *  ledger column — true only while `rebaseAskedAt` is set. */
export async function isRebaseAsked(number: number): Promise<boolean> {
  const rows = await db
    .select({ rebaseAskedAt: pullRequests.rebaseAskedAt })
    .from(pullRequests)
    .where(eq(pullRequests.number, number));
  return rows[0]?.rebaseAskedAt != null;
}

/** Record that we've asked @claude to rebase this PR (stamps the ledger). */
export async function markRebaseAsked(number: number): Promise<void> {
  await db
    .update(pullRequests)
    .set({ rebaseAskedAt: new Date(), updatedAt: new Date() })
    .where(eq(pullRequests.number, number));
}

/** Forget the ask, ending the conflict episode so a later, distinct conflict on the
 *  same PR re-asks. Called when the PR goes MERGEABLE or leaves the board. */
export async function clearRebaseAsked(number: number): Promise<void> {
  await db
    .update(pullRequests)
    .set({ rebaseAskedAt: null, updatedAt: new Date() })
    .where(eq(pullRequests.number, number));
}
