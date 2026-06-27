import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PM_DATA_DIR = join(mkdtempSync(join(tmpdir(), "pm-")), "pg");

const { ready } = await import("../src/server/db.ts");
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
  // The resolved tasks come back in the requested order.
  expect(built.tasks.map((t) => t.id)).toEqual(ids);
});

test("loadTaskPrompt returns null if any task in the list is unknown", async () => {
  const [task] = await taskRepo.list();
  expect(await loadTaskPrompt([task.id, 99999])).toBeNull();
});
