import { beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PM_DATA_DIR = join(mkdtempSync(join(tmpdir(), "pm-")), "pg");

const { ready } = await import("../src/server/db.ts");
const { loadPlan, parsePlan } = await import("../src/server/plan.ts");
const { goalRepo, milestoneRepo, taskRepo, phaseRepo } = await import("../src/server/crud.ts");
const { planToMarkdown, parsePlanMarkdown, loadPlanTree, applyPlanMarkdown, applyChangesToTree } =
  await import("../src/server/markdown.ts");

beforeAll(async () => {
  await ready();
});

test("planToMarkdown ↔ parsePlanMarkdown round-trips a tree losslessly", () => {
  const plan = {
    goals: [
      {
        id: 1,
        title: "Ship auth",
        objective: "let users log in",
        milestones: [
          {
            id: 5,
            title: "Tokens",
            tasks: [
              {
                id: 9,
                title: "JWT issuing",
                phases: [
                  { id: 2, name: "write tests", done: false },
                  { id: 3, name: "implement", done: true },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  const md = planToMarkdown(plan);
  // It looks like a plan: headings + a checklist + id chips.
  expect(md).toContain("# Ship auth `g1`");
  expect(md).toContain("> let users log in");
  expect(md).toContain("## Tokens `m5`");
  expect(md).toContain("### JWT issuing `t9`");
  expect(md).toContain("- [ ] write tests `p2`");
  expect(md).toContain("- [x] implement `p3`");

  // And parsing it back reproduces the tree.
  expect(parsePlanMarkdown(md)).toEqual(plan);
});

test("an untagged node parses as a create (no id)", () => {
  const md = ["# Brand new goal", "## New milestone", "### New task", "- [ ] a step"].join("\n");
  const parsed = parsePlanMarkdown(md);
  const g = parsed.goals[0];
  expect(g.id).toBeUndefined();
  expect(g.title).toBe("Brand new goal");
  expect(g.milestones[0].id).toBeUndefined();
  expect(g.milestones[0].tasks[0].phases[0]).toEqual({ name: "a step", done: false });
});

test("planMarkdown reflects the live plan, and applyPlanMarkdown reconciles edits back", async () => {
  await loadPlan(
    parsePlan({
      goals: [
        {
          title: "G",
          milestones: [
            {
              title: "M",
              tasks: [{ title: "Keep me", phases: [{ name: "p1" }] }, { title: "Drop me" }],
            },
          ],
        },
      ],
    }),
  );

  const tree = await loadPlanTree();
  const keep = tree.goals[0].milestones[0].tasks.find((t) => t.title === "Keep me");
  const drop = tree.goals[0].milestones[0].tasks.find((t) => t.title === "Drop me");
  const goalId = tree.goals[0].id;
  const mId = tree.goals[0].milestones[0].id;
  const keepPhaseId = keep?.phases[0]?.id;
  if (!keep?.id || !drop?.id || goalId == null || mId == null || keepPhaseId == null)
    throw new Error("seed failed");

  // Edit the text: rename "Keep me", add a brand-new task, omit "Drop me" (→ archive).
  const edited = [
    `# G renamed \`g${goalId}\``,
    "",
    `## M \`m${mId}\``,
    "",
    `### Keep me, renamed \`t${keep.id}\``,
    `- [x] p1 \`p${keepPhaseId}\``,
    "",
    "### A new task",
    "- [ ] fresh phase",
  ].join("\n");

  const res = await applyPlanMarkdown(edited);
  expect(res.created).toBeGreaterThanOrEqual(2); // new task + its phase
  expect(res.archived).toBe(1); // Drop me

  // The edits landed.
  expect((await goalRepo.get(goalId))?.title).toBe("G renamed");
  expect((await taskRepo.get(keep.id))?.title).toBe("Keep me, renamed");
  expect((await phaseRepo.get(keepPhaseId))?.status).toBe("done");
  expect((await taskRepo.get(drop.id))?.archivedAt).toBeTruthy();
  const tasksNow = (await taskRepo.list()).filter((t) => t.milestoneId === mId);
  expect(tasksNow.some((t) => t.title === "A new task")).toBe(true);
});

test("applyChangesToTree projects a proposal's change-set onto the tree", () => {
  const base = {
    goals: [
      {
        id: 1,
        title: "G",
        objective: "",
        milestones: [
          {
            id: 2,
            title: "M",
            tasks: [{ id: 3, title: "Old", phases: [] }],
          },
        ],
      },
    ],
  };
  const projected = applyChangesToTree(base, [
    { op: "update", kind: "task", id: 3, fields: { title: "Renamed" } },
    { op: "create", kind: "task", parentId: 2, fields: { title: "Added" } },
  ]);
  const titles = projected.goals[0].milestones[0].tasks.map((t) => t.title);
  expect(titles).toEqual(["Renamed", "Added"]);
  // The created node has no id → renders chip-less (reads as an addition in a diff).
  const added = projected.goals[0].milestones[0].tasks.find((t) => t.title === "Added");
  expect(added?.id).toBeUndefined();
  // The base tree is untouched (projection is pure).
  expect(base.goals[0].milestones[0].tasks).toHaveLength(1);
});
