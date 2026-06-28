import { beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PM_DATA_DIR = join(mkdtempSync(join(tmpdir(), "pm-")), "pg");

const { ready } = await import("../src/server/db.ts");
const { loadPlan, parsePlan } = await import("../src/server/plan.ts");
const { goalRepo, milestoneRepo, taskRepo } = await import("../src/server/crud.ts");
const { createProposal, getProposal, listPending, decideProposal, snapshotBase, baseKey } =
  await import("../src/server/proposals.ts");

beforeAll(async () => {
  await ready();
  await loadPlan(
    parsePlan({
      goals: [
        {
          title: "Goal A",
          milestones: [{ title: "M1", tasks: [{ title: "T1", phases: [{ name: "p" }] }] }],
        },
      ],
    }),
  );
});

test("create snapshots the base of every referenced existing row, stored pending", async () => {
  const [goal] = await goalRepo.list();
  const [task] = await taskRepo.list();

  const proposal = await createProposal({
    title: "tweak",
    summary: "rename the task and add one",
    changes: [
      { op: "update", kind: "task", id: task.id, fields: { title: "T1 renamed" } },
      { op: "create", kind: "task", parentId: task.milestoneId, fields: { title: "T2" } },
    ],
  });

  expect(proposal.status).toBe("pending");
  // The updated task and the create's parent milestone are both in the base.
  expect(proposal.base[baseKey("task", task.id)]).toBeTruthy();
  expect(proposal.base[baseKey("milestone", task.milestoneId)]).toBeTruthy();
  // A create with no existing target doesn't invent a base key for itself.
  expect(Object.keys(proposal.base).length).toBe(2);
  // Nothing was applied — the live task keeps its original title.
  expect((await taskRepo.get(task.id))?.title).toBe("T1");
  // goal is untouched / not referenced.
  expect(goal.title).toBe("Goal A");
});

test("absent referenced rows are recorded as absent in the base", async () => {
  const base = await snapshotBase([{ op: "archive", kind: "goal", id: 9999 }]);
  expect(base[baseKey("goal", 9999)]).toBe("absent");
});

test("list pending returns only pending proposals", async () => {
  const before = await listPending();
  const p = await createProposal({
    changes: [{ op: "archive", kind: "milestone", id: 1 }],
  });
  const after = await listPending();
  expect(after.length).toBe(before.length + 1);
  expect(after.some((x) => x.id === p.id)).toBe(true);
});

test("approve / reject only act on a pending proposal", async () => {
  const [milestone] = await milestoneRepo.list();
  const p = await createProposal({
    changes: [{ op: "update", kind: "milestone", id: milestone.id, fields: { title: "M1!" } }],
  });

  const approved = await decideProposal(p.id, "approved");
  expect(approved?.status).toBe("approved");
  // No longer pending → a second decision is a no-op (undefined).
  expect(await decideProposal(p.id, "rejected")).toBeUndefined();
  // And it's out of the pending queue.
  expect((await listPending()).some((x) => x.id === p.id)).toBe(false);

  const r = await createProposal({
    changes: [{ op: "update", kind: "milestone", id: milestone.id, fields: { title: "M1?" } }],
  });
  const rejected = await decideProposal(r.id, "rejected");
  expect(rejected?.status).toBe("rejected");
  expect((await getProposal(r.id))?.status).toBe("rejected");
});
