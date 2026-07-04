import { asc, eq, isNull } from "drizzle-orm";
import { ProposalOp, TaskKind, VocabKind } from "../shared/types.ts";
import { db } from "./db.ts";
import type { CloudPr } from "./events.ts";
import { createProposal } from "./proposals.ts";
import { milestones, type Proposal, proposals, tasks } from "./schema.ts";

// Follow-ups: the capture half of "a worker hands an out-of-scope find back to the
// operator". The *triage* half is the existing proposal-review flow (proposals.ts):
// a follow-up is authored as an ordinary pending proposal whose change-set is a
// single `create task`, so it lands in the operator's decision queue and is
// approved→applied (the task joins the plan) or rejected — no separate machinery.
// What's unique here is (a) turning a one-line follow-up into that change-set, and
// (b) the two capture channels that call it: a local worker POSTs /followups; a
// cloud worker (which can't reach $PM_URL) leaves a `<!-- pm:followup -->` PR comment
// the watcher slurps (see ingestFollowups + github-watch).

export type FollowupInput = {
  title: string;
  /** Optional context — why it matters, where it was seen. Rides in the proposal summary. */
  body?: string;
  /** The task the worker was on when it spotted this — picks the milestone the
   *  proposed task is parented under, and recorded as provenance. */
  sourceTaskId?: number | null;
  /** The cloud PR the follow-up was slurped from (provenance), if any. */
  sourcePr?: number | null;
  /** The GitHub comment databaseId a cloud follow-up came from — the ingest dedup key. */
  sourceCommentId?: number | null;
};

export type FollowupResult = { ok: true; proposal: Proposal } | { ok: false; error: string };

/** Pick the milestone a follow-up's proposed task should hang under: the milestone of
 *  the worker's source task when known, else the first live milestone (lowest
 *  position). Null when there are no milestones at all — a task needs a parent, so a
 *  follow-up can't be proposed into an empty plan. */
async function targetMilestoneId(sourceTaskId?: number | null): Promise<number | null> {
  if (sourceTaskId != null) {
    const [task] = await db.select().from(tasks).where(eq(tasks.id, sourceTaskId));
    if (task) return task.milestoneId;
  }
  const [first] = await db
    .select({ id: milestones.id })
    .from(milestones)
    .where(isNull(milestones.archivedAt))
    .orderBy(asc(milestones.position), asc(milestones.id))
    .limit(1);
  return first?.id ?? null;
}

// The longest title a follow-up may author onto a task card. Workers routinely hand
// back a whole paragraph as the "title" (t927 was a wall of text); past this the text
// is clamped to a scannable card title and the FULL text moves to the description.
const MAX_TITLE = 80;

/** Clamp a wall-of-text title to a short card title, cutting at a word boundary when
 *  one falls late enough to keep the title substantial. Flags whether it clamped so
 *  the caller can preserve the full text in the description. */
function shortTitle(full: string): { title: string; truncated: boolean } {
  if (full.length <= MAX_TITLE) return { title: full, truncated: false };
  const hard = full.slice(0, MAX_TITLE);
  const atWord = hard.slice(0, hard.lastIndexOf(" "));
  return {
    title: `${(atWord.length >= MAX_TITLE / 2 ? atWord : hard).trimEnd()}…`,
    truncated: true,
  };
}

/** One-line provenance note appended to the proposal summary, so the operator
 *  reviewing the change knows it came from a worker hand-back and from where. */
function provenanceNote(input: FollowupInput): string {
  const bits: string[] = [];
  if (input.sourceTaskId != null) bits.push(`task t${input.sourceTaskId}`);
  if (input.sourcePr != null) bits.push(`PR #${input.sourcePr}`);
  const where = bits.length ? ` (from ${bits.join(", ")})` : "";
  return `Handed back by a worker as out-of-scope${where}.`;
}

/** Author a follow-up as a pending `create task` proposal under the resolved
 *  milestone, stamped with its provenance. The proposed task is a `bug` (a worker
 *  hand-back is a spotted defect/cleanup — discovery-first, so no phases either) with
 *  a SHORT title; the worker's body — plus the full text of a clamped wall-of-text
 *  title — lands in the task's description, not the title. Returns the created
 *  proposal, or an error when the title is empty or the plan has no milestone to
 *  attach a task to. */
export async function proposeFollowup(input: FollowupInput): Promise<FollowupResult> {
  const full = input.title.trim();
  if (!full) return { ok: false, error: "follow-up title is empty" };
  const { title, truncated } = shortTitle(full);

  const milestoneId = await targetMilestoneId(input.sourceTaskId);
  if (milestoneId == null)
    return { ok: false, error: "no milestone to attach the follow-up to (load a plan first)" };

  // The task's own context field: the untruncated title (when it was clamped) plus
  // the worker's body. The proposal summary below still carries the body too — that's
  // what the operator reads in the decision queue.
  const description = [truncated ? full : null, input.body?.trim() || null]
    .filter(Boolean)
    .join("\n\n");
  const summary = [input.body?.trim(), provenanceNote(input)].filter(Boolean).join("\n\n");
  const proposal = await createProposal({
    title: `Follow-up: ${title}`,
    summary,
    changes: [
      {
        op: ProposalOp.Create,
        kind: VocabKind.Task,
        parentId: milestoneId,
        fields: { title, kind: TaskKind.Bug, ...(description && { description }) },
      },
    ],
  });

  // Stamp provenance on the row (createProposal doesn't carry these). Idempotency for
  // the cloud channel reads sourceCommentId back off this.
  const [stamped] = await db
    .update(proposals)
    .set({
      sourceTaskId: input.sourceTaskId ?? null,
      sourcePr: input.sourcePr ?? null,
      sourceCommentId: input.sourceCommentId ?? null,
      updatedAt: new Date(),
    })
    .where(eq(proposals.id, proposal.id))
    .returning();
  return { ok: true, proposal: stamped ?? proposal };
}

/** Slurp a cloud PR's `<!-- pm:followup -->` comments into proposals — the channel
 *  for workers that can't reach the API. Idempotent by GitHub comment id: a comment
 *  already turned into a proposal (matched on `sourceCommentId`, archived rows
 *  included) is skipped, so re-reading it every tick — or replaying it on a restart
 *  catch-up — never duplicates, and a follow-up the operator already rejected stays
 *  gone. A comment with no id is skipped rather than risk an un-dedupable duplicate.
 *  Returns how many proposals were created. */
export async function ingestFollowups(pr: CloudPr): Promise<number> {
  let created = 0;
  for (const f of pr.followups ?? []) {
    if (f.commentId == null) continue;
    const existing = await db
      .select({ id: proposals.id })
      .from(proposals)
      .where(eq(proposals.sourceCommentId, f.commentId));
    if (existing.length > 0) continue;
    const r = await proposeFollowup({
      title: f.title,
      body: f.body,
      sourceTaskId: pr.taskId,
      sourcePr: pr.number,
      sourceCommentId: f.commentId,
    });
    if (r.ok) created++;
  }
  return created;
}
