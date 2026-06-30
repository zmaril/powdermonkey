import { beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Follow-up capture: a worker hand-back becomes a pending `create task` proposal in
// the existing review flow, and the cloud slurp (ingestFollowups) is idempotent by
// GitHub comment id — the watcher re-reads the same `<!-- pm:followup -->` comment
// every tick and on a restart catch-up, so a comment must become a proposal exactly
// once. Run against a throwaway PGlite store, like the other DB-touching suites.
process.env.PM_DATA_DIR = join(mkdtempSync(join(tmpdir(), "pm-")), "pg");
const { ready } = await import("../src/server/db.ts");
const { loadPlan } = await import("../src/server/plan.ts");
const { milestoneRepo, taskRepo } = await import("../src/server/crud.ts");
const { listProposals, decideProposal } = await import("../src/server/proposals.ts");
const { ProposalStatus } = await import("../src/shared/types.ts");
const { applyProposal } = await import("../src/server/apply.ts");
const { proposeFollowup, ingestFollowups } = await import("../src/server/followups.ts");
type CloudPr = import("../src/server/events.ts").CloudPr;

function cloudPr(over: Partial<CloudPr> & { number: number; taskId: number }): CloudPr {
  return {
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
  expect(r.proposal.changes).toEqual([
    { op: "create", kind: "task", parentId: milestoneA, fields: { title: "Dedup helpers" } },
  ]);
  expect(r.proposal.summary).toContain("two copies");
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
