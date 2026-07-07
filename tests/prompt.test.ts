import { afterAll, beforeAll, expect, test } from "bun:test";
import { setupTestDb } from "./db-harness.ts";

const { ready } = await setupTestDb();
const { loadPlan, parsePlan } = await import("../src/server/plan.ts");
const { taskRepo } = await import("../src/server/crud.ts");
const { loadTaskPrompt } = await import("../src/server/dispatch.ts");
const { app } = await import("../src/server/app.ts");

let base: string;

beforeAll(async () => {
  await ready();
  await loadPlan(
    parsePlan({
      goals: [
        {
          title: "G",
          milestones: [
            {
              title: "m",
              tasks: [
                {
                  title: "build the thing",
                  description: "the thing is load-bearing; don't break the old callers",
                  phases: [{ name: "write tests" }, { name: "implement" }],
                },
                {
                  title: "polish the thing",
                  phases: [{ name: "refactor" }],
                },
              ],
            },
          ],
        },
      ],
    }),
  );
  // Routes only compile once the server is listening; bind an ephemeral port.
  app.listen(0);
  base = `http://localhost:${app.server?.port}`;
});

afterAll(() => app.stop());

test("GET /tasks/:id/prompt returns the prompt + phase trailers", async () => {
  const [task] = await taskRepo.list();
  const res = await fetch(`${base}/tasks/${task.id}/prompt`);
  expect(res.status).toBe(200);

  const body = (await res.json()) as { prompt: string; trailers: string[] };
  expect(body.prompt).toContain("Task: build the thing");
  // The task's description rides along, framing the phases below it.
  expect(body.prompt).toContain("the thing is load-bearing; don't break the old callers");
  expect(body.prompt).toContain("write tests");
  expect(body.prompt).toContain("PM-Phase:");
  // one trailer per phase, each naming its phase
  expect(body.trailers).toHaveLength(2);
  expect(body.trailers[0]).toMatch(/^PM-Phase: \d+ {3}# write tests$/);
  expect(body.trailers[1]).toMatch(/^PM-Phase: \d+ {3}# implement$/);
});

test("GET /tasks/:id/prompt 404s for an unknown task", async () => {
  const res = await fetch(`${base}/tasks/99999/prompt`);
  expect(res.status).toBe(404);
});

test("loadTaskPrompt combines several tasks into one brief", async () => {
  const tasks = (await taskRepo.list()).sort((a, b) => a.id - b.id);
  const ids = tasks.map((t) => t.id);
  const built = await loadTaskPrompt(ids);
  if (!built) throw new Error("no prompt");

  // Every task's title and a multi-task header are present.
  expect(built.prompt).toContain("2 tasks to complete");
  expect(built.prompt).toContain("Task: build the thing");
  expect(built.prompt).toContain("Task: polish the thing");
  // Trailers are the flat union across all tasks (2 + 1 phases).
  expect(built.trailers).toHaveLength(3);
  expect(built.prompt).toContain("refactor");
  // The described task carries its narrative; the description-less one doesn't
  // sprout a stray line — its section jumps straight from title to "Phases:".
  expect(built.prompt).toContain("the thing is load-bearing; don't break the old callers");
  expect(built.prompt).toContain("Task: polish the thing\n\nPhases:");
});

test("loadTaskPrompt returns null if any task in the list is unknown", async () => {
  const [task] = await taskRepo.list();
  expect(await loadTaskPrompt([task.id, 99999])).toBeNull();
});

test("the brief includes the task's diary lines, attributed by author", async () => {
  const [task] = (await taskRepo.list()).sort((a, b) => a.id - b.id);
  // Muttered onto the task in order: an operator line then a supervisor line.
  await fetch(`${base}/tasks/${task.id}/comments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body: "not sure the FK belongs here" }),
  });
  await fetch(`${base}/tasks/${task.id}/comments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body: "split this out per the proposal", author: "supervisor" }),
  });

  const built = await loadTaskPrompt(task.id);
  if (!built) throw new Error("no prompt");
  expect(built.prompt).toContain("Diary");
  // Operator lines read bare; supervisor lines are attributed.
  expect(built.prompt).toContain("- not sure the FK belongs here");
  expect(built.prompt).toContain("- (supervisor) split this out per the proposal");
  // Oldest first — the operator line comes before the supervisor line.
  expect(built.prompt.indexOf("not sure the FK")).toBeLessThan(
    built.prompt.indexOf("split this out"),
  );
});

test("a task with no diary gets no Diary block", async () => {
  // The second task ("polish the thing") has no comments.
  const tasks = (await taskRepo.list()).sort((a, b) => a.id - b.id);
  const built = await loadTaskPrompt(tasks[1].id);
  if (!built) throw new Error("no prompt");
  expect(built.prompt).toContain("Task: polish the thing");
  expect(built.prompt).not.toContain("Diary");
});
