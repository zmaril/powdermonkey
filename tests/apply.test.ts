import { beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PM_DATA_DIR = join(mkdtempSync(join(tmpdir(), "pm-")), "pg");

const { ready } = await import("../src/server/db.ts");
const { loadPlan, parsePlan } = await import("../src/server/plan.ts");
const { goalRepo, milestoneRepo, taskRepo, phaseRepo } = await import("../src/server/crud.ts");
const { createProposal, decideProposal, getProposal } = await import("../src/server/proposals.ts");
const { applyProposal } = await import("../src/server/apply.ts");

beforeAll(async () => {
  await ready();
});

async function seedGoalWithMilestone() {
  await loadPlan(
    parsePlan({
      goals: [{ title: "G", milestones: [{ title: "M", tasks: [{ title: "T" }] }] }],
    }),
  );
}

test("approved change-set applies atomically: create + update + archive + reorder", async () => {
  await seedGoalWithMilestone();
  const [milestone] = await milestoneRepo.list();
  const [task] = await taskRepo.list();

  const proposal = await createProposal({
    title: "restructure",
    changes: [
      // create a new task with a child phase via parentRef (a whole subtree)
      {
        op: "create",
        kind: "task",
        ref: "newTask",
        parentId: milestone.id,
        fields: { title: "T2" },
        position: 1,
      },
      { op: "create", kind: "phase", parentRef: "newTask", fields: { name: "phase A" } },
      // update the existing task
      { op: "update", kind: "task", id: task.id, fields: { title: "T renamed" } },
      // reorder it to the front
      { op: "reorder", kind: "task", id: task.id, position: 0 },
    ],
  });
  await decideProposal(proposal.id, "approved");

  const result = await applyProposal(proposal.id);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.applied).toBe(true);
  expect(result.counts).toEqual({ create: 2, update: 1, archive: 0, reorder: 1 });

  // The new subtree exists and is wired up.
  const tasks = await taskRepo.list();
  const t2 = tasks.find((t) => t.title === "T2");
  expect(t2?.milestoneId).toBe(milestone.id);
  expect(t2?.position).toBe(1);
  const phases = await phaseRepo.list();
  expect(phases.some((p) => p.name === "phase A" && p.taskId === t2?.id)).toBe(true);

  // The existing task was updated and reordered.
  const updated = await taskRepo.get(task.id);
  expect(updated?.title).toBe("T renamed");
  expect(updated?.position).toBe(0);

  // The proposal is now applied and stamped.
  const fresh = await getProposal(proposal.id);
  expect(fresh?.status).toBe("applied");
  expect(fresh?.appliedAt).toBeTruthy();
});

test("archive op soft-deletes the target", async () => {
  await loadPlan(parsePlan({ goals: [{ title: "Garch" }] }));
  const goal = (await goalRepo.list()).find((g) => g.title === "Garch");
  if (!goal) throw new Error("seed failed");

  const proposal = await createProposal({
    changes: [{ op: "archive", kind: "goal", id: goal.id }],
  });
  await decideProposal(proposal.id, "approved");
  const result = await applyProposal(proposal.id);
  expect(result.ok).toBe(true);
  expect((await goalRepo.get(goal.id))?.archivedAt).toBeTruthy();
});

test("a stale base is detected and nothing is applied", async () => {
  await loadPlan(parsePlan({ goals: [{ title: "Gstale" }] }));
  const goal = (await goalRepo.list()).find((g) => g.title === "Gstale");
  if (!goal) throw new Error("seed failed");

  const proposal = await createProposal({
    changes: [{ op: "update", kind: "goal", id: goal.id, fields: { title: "via proposal" } }],
  });
  await decideProposal(proposal.id, "approved");

  // The plan moves underneath the proposal: a direct edit bumps updated_at.
  await new Promise((r) => setTimeout(r, 5));
  await goalRepo.update(goal.id, { title: "edited directly" });

  const result = await applyProposal(proposal.id);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.conflicts?.length).toBe(1);
  expect(result.conflicts?.[0].entity).toBe(`goal:${goal.id}`);
  // The direct edit is intact — the proposal didn't clobber it.
  expect((await goalRepo.get(goal.id))?.title).toBe("edited directly");
  // And the proposal stays approved (not applied) so it can be re-snapshotted/redone.
  expect((await getProposal(proposal.id))?.status).toBe("approved");
});

test("apply requires approval and is idempotent on re-apply", async () => {
  await loadPlan(parsePlan({ goals: [{ title: "Gidem" }] }));
  const goal = (await goalRepo.list()).find((g) => g.title === "Gidem");
  if (!goal) throw new Error("seed failed");

  const proposal = await createProposal({
    changes: [{ op: "update", kind: "goal", id: goal.id, fields: { objective: "done" } }],
  });

  // Pending → apply refuses.
  const tooEarly = await applyProposal(proposal.id);
  expect(tooEarly.ok).toBe(false);

  await decideProposal(proposal.id, "approved");
  const first = await applyProposal(proposal.id);
  expect(first.ok).toBe(true);
  if (first.ok) expect(first.applied).toBe(true);

  // Re-apply is a no-op: applied=false, no extra mutation.
  const second = await applyProposal(proposal.id);
  expect(second.ok).toBe(true);
  if (second.ok) {
    expect(second.applied).toBe(false);
    expect(second.counts).toEqual({ create: 0, update: 0, archive: 0, reorder: 0 });
  }
  expect((await goalRepo.get(goal.id))?.objective).toBe("done");
});
