import { beforeAll, expect, test } from "bun:test";
import { setupTestDb } from "./db-harness.ts";

// Follow-up capture: a worker hand-back becomes a pending `create task` proposal in
// the existing review flow, and the cloud slurp (ingestFollowups) is idempotent by
// GitHub comment id — the watcher re-reads the same `<!-- pm:followup -->` comment
// every tick and on a restart catch-up, so a comment must become a proposal exactly
// once. Run against a throwaway PGlite store, like the other DB-touching suites.
const { ready } = await setupTestDb();
const { loadPlan } = await import("../src/server/plan.ts");
const { milestoneRepo, taskRepo } = await import("../src/server/crud.ts");
const { listProposals, decideProposal } = await import("../src/server/proposals.ts");
const { ProposalStatus } = await import("../src/shared/types.ts");
const { applyProposal } = await import("../src/server/apply.ts");
const { proposeFollowup, ingestFollowups } = await import("../src/server/followups.ts");
type CloudPr = import("../src/server/events.ts").CloudPr;

function cloudPr(over: Partial<CloudPr> & { number: number; taskId: number }): CloudPr {
  return {
    repo: "o/r",
    title: `PR ${over.number}`,
    url: `https://github.com/o/r/pull/${over.number}`,
    state: "OPEN",
    isDraft: false,
    merged: false,
    checks: null,
    mergeable: null,
    headRefName: `pm/task-${over.taskId}-slug`,
    updatedAt: "2026-06-28T00:00:00Z",
    agent: null,
    followups: [],
    lastComment: null,
    lastCommentAt: null,
    lastCommentUrl: null,
    ...over,
  };
}

let milestoneA: number;
let milestoneB: number;
let taskInB: number;

beforeAll(async () => {
  await ready();
  // Two milestones; a task lives under the second, so we can prove a follow-up from
  // that task is parented under ITS milestone, not the first.
  await loadPlan({
    goals: [
      {
        title: "G",
        milestones: [
          { title: "First", tasks: [] },
          { title: "Second", tasks: [{ title: "host task", phases: [] }] },
        ],
      },
    ],
  });
  const ms = (await milestoneRepo.list()).sort((a, b) => a.position - b.position || a.id - b.id);
  milestoneA = ms[0].id;
  milestoneB = ms[1].id;
  taskInB = (await taskRepo.list()).find((t) => t.milestoneId === milestoneB)?.id as number;
});

test("proposeFollowup authors a pending create-task proposal under the first milestone (no source)", async () => {
  const r = await proposeFollowup({ title: "Dedup helpers", body: "two copies" });
  if (!r.ok) throw new Error(r.error);
  expect(r.proposal.status).toBe("pending");
  expect(r.proposal.title).toBe("Follow-up: Dedup helpers");
  // The proposed task is a bug (a hand-back is a spotted defect/cleanup) and the
  // worker's body rides in the task's own description, not just the summary.
  expect(r.proposal.changes).toEqual([
    {
      op: "create",
      kind: "task",
      parentId: milestoneA,
      fields: { title: "Dedup helpers", kind: "bug", description: "two copies" },
    },
  ]);
  expect(r.proposal.summary).toContain("two copies");
});

test("proposeFollowup clamps a wall-of-text title and preserves the full text in the description", async () => {
  const wall =
    "The reconcile loop rescans every repo on every tick even when nothing changed, " +
    "which hammers the GitHub API and makes the Active panel lag behind by several seconds";
  const r = await proposeFollowup({ title: wall, body: "spotted while working t927" });
  if (!r.ok) throw new Error(r.error);
  const change = r.proposal.changes[0] as { fields: Record<string, unknown> };
  const title = change.fields.title as string;
  expect(title.length).toBeLessThanOrEqual(81); // 80 + the ellipsis
  expect(title.endsWith("…")).toBe(true);
  expect(wall.startsWith(title.slice(0, -1))).toBe(true); // a prefix, cut at a word
  // Nothing lost: the full title AND the body both land in the description.
  expect(change.fields.description as string).toContain(wall);
  expect(change.fields.description as string).toContain("spotted while working t927");
  expect(change.fields.kind).toBe("bug");
});

test("proposeFollowup omits the description when there is no body and no clamp", async () => {
  const r = await proposeFollowup({ title: "Short and bodyless" });
  if (!r.ok) throw new Error(r.error);
  const change = r.proposal.changes[0] as { fields: Record<string, unknown> };
  expect(change.fields).toEqual({ title: "Short and bodyless", kind: "bug" });
});

test("proposeFollowup parents the task under the SOURCE task's milestone + stamps provenance", async () => {
  const r = await proposeFollowup({ title: "Add a retry", sourceTaskId: taskInB, sourcePr: 42 });
  if (!r.ok) throw new Error(r.error);
  expect(r.proposal.changes[0]).toMatchObject({ kind: "task", parentId: milestoneB });
  expect(r.proposal.sourceTaskId).toBe(taskInB);
  expect(r.proposal.sourcePr).toBe(42);
  expect(r.proposal.summary).toContain("task t");
});

test("proposeFollowup rejects an empty title", async () => {
  const r = await proposeFollowup({ title: "   " });
  expect(r.ok).toBe(false);
});

test("an approved follow-up applies into a real Task in the plan", async () => {
  const r = await proposeFollowup({ title: "Promote me", sourceTaskId: taskInB });
  if (!r.ok) throw new Error(r.error);
  await decideProposal(r.proposal.id, ProposalStatus.Approved);
  const applied = await applyProposal(r.proposal.id);
  expect(applied.ok).toBe(true);
  const task = (await taskRepo.list()).find((t) => t.title === "Promote me");
  expect(task?.milestoneId).toBe(milestoneB);
});

test("ingestFollowups creates one proposal per marked comment, carrying provenance", async () => {
  const before = (await listProposals()).length;
  const created = await ingestFollowups(
    cloudPr({
      number: 7,
      taskId: taskInB,
      followups: [
        { commentId: 1001, title: "Cloud follow-up one", body: "ctx", updatedAt: "t1" },
        { commentId: 1002, title: "Cloud follow-up two", body: "", updatedAt: "t2" },
      ],
    }),
  );
  expect(created).toBe(2);
  const all = await listProposals();
  expect(all.length).toBe(before + 2);
  const p = all.find((x) => x.sourceCommentId === 1001);
  expect(p).toMatchObject({ sourcePr: 7, sourceTaskId: taskInB, status: "pending" });
  expect(p?.title).toBe("Follow-up: Cloud follow-up one");
});

test("ingestFollowups handles a real (billions-range) GitHub comment id without overflowing", async () => {
  // GitHub comment databaseIds are ~10 digits, past int4's 2.1B ceiling; sourceCommentId
  // must be bigint or the ingest write throws "out of range for type integer". 4827711718
  // is the id that surfaced the bug in the running supervisor.
  const bigId = 4827711718;
  const created = await ingestFollowups(
    cloudPr({
      number: 9,
      taskId: taskInB,
      followups: [{ commentId: bigId, title: "Big-id follow-up", body: "ctx", updatedAt: "t3" }],
    }),
  );
  expect(created).toBe(1);
  const p = (await listProposals()).find((x) => x.sourceCommentId === bigId);
  expect(p).toMatchObject({ sourcePr: 9, sourceTaskId: taskInB, status: "pending" });
  // And still idempotent at that magnitude (the dedup WHERE also compares the big id).
  expect(
    await ingestFollowups(
      cloudPr({
        number: 9,
        taskId: taskInB,
        followups: [{ commentId: bigId, title: "Big-id follow-up", body: "ctx", updatedAt: "t3" }],
      }),
    ),
  ).toBe(0);
});

test("ingestFollowups is idempotent — re-reading the same comments creates nothing new", async () => {
  const pr = cloudPr({
    number: 7,
    taskId: taskInB,
    followups: [{ commentId: 1001, title: "Cloud follow-up one", body: "ctx", updatedAt: "t1" }],
  });
  expect(await ingestFollowups(pr)).toBe(0);
});

test("ingestFollowups skips a comment with no id (can't dedup it safely)", async () => {
  const before = (await listProposals()).length;
  const created = await ingestFollowups(
    cloudPr({
      number: 8,
      taskId: taskInB,
      followups: [{ commentId: null, title: "no id", body: "", updatedAt: null }],
    }),
  );
  expect(created).toBe(0);
  expect((await listProposals()).length).toBe(before);
});
