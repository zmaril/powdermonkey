import { beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The task's diary: append-only comments on a task. Appends are auto-timestamped
// and read back oldest-first; a line can be deleted (hard DELETE, scoped to its
// task) but never edited — there is no update function and no PATCH route, and
// this suite pins that surface. Runs against a throwaway PGlite store, like the
// other DB-touching suites.
process.env.PM_DATA_DIR = join(mkdtempSync(join(tmpdir(), "pm-")), "pg");
const { ready } = await import("../src/server/db.ts");
const { loadPlan } = await import("../src/server/plan.ts");
const { appendComment, deleteComment, listComments } = await import("../src/server/comments.ts");
const { CommentAuthor } = await import("../src/shared/types.ts");
const { app } = await import("../src/server/app.ts");

let taskId: number;

beforeAll(async () => {
  await ready();
  await loadPlan({
    goals: [
      {
        title: "diary goal",
        milestones: [{ title: "m", tasks: [{ title: "the task", phases: [] }] }],
      },
    ],
  });
  const { taskRepo } = await import("../src/server/crud.ts");
  const tasks = await taskRepo.list();
  taskId = tasks[0].id;
});

test("append is auto-timestamped and defaults to the operator voice", async () => {
  const row = await appendComment(taskId, "first mutter");
  expect(row).not.toBeNull();
  expect(row?.body).toBe("first mutter");
  expect(row?.author).toBe(CommentAuthor.Operator);
  expect(row?.createdAt).toBeInstanceOf(Date);
});

test("the supervisor can speak too", async () => {
  const row = await appendComment(taskId, "operator was unsure here", CommentAuthor.Supervisor);
  expect(row?.author).toBe(CommentAuthor.Supervisor);
});

test("list reads the diary oldest-first", async () => {
  await appendComment(taskId, "a later line");
  const rows = await listComments(taskId);
  expect(rows.map((r) => r.body)).toEqual(["first mutter", "operator was unsure here", "a later line"]);
  const times = rows.map((r) => r.createdAt.getTime());
  expect([...times].sort((a, b) => a - b)).toEqual(times);
});

test("append to a task that doesn't exist is a clean null (404 at the route)", async () => {
  expect(await appendComment(999_999, "into the void")).toBeNull();
});

test("delete takes a line back outright, scoped to its task", async () => {
  const row = await appendComment(taskId, "on second thought");
  if (!row) throw new Error("append failed");
  // A wrong-task id can't cross diaries.
  expect(await deleteComment(taskId + 1, row.id)).toBeNull();
  const gone = await deleteComment(taskId, row.id);
  expect(gone?.id).toBe(row.id);
  expect((await listComments(taskId)).some((c) => c.id === row.id)).toBe(false);
  // Deleting again finds nothing.
  expect(await deleteComment(taskId, row.id)).toBeNull();
});

test("routes: append + list + delete exist; there is NO edit route", async () => {
  // NB: a real-looking host matters — Elysia's router mis-resolves a bare
  // single-label host like `http://pm` into the SPA fallback.
  const base = "http://localhost";
  const posted = await app.handle(
    new Request(`${base}/tasks/${taskId}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "via the API" }),
    }),
  );
  expect(posted.status).toBe(200);
  const created = (await posted.json()) as { id: number; body: string };
  expect(created.body).toBe("via the API");

  const listed = await app.handle(new Request(`${base}/tasks/${taskId}/comments`));
  const rows = (await listed.json()) as Array<{ id: number }>;
  expect(rows.some((r) => r.id === created.id)).toBe(true);

  // Append-only by design: no PATCH on a comment — the route simply doesn't exist.
  const patched = await app.handle(
    new Request(`${base}/tasks/${taskId}/comments/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "rewritten" }),
    }),
  );
  expect(patched.status).toBe(404);

  const deleted = await app.handle(
    new Request(`${base}/tasks/${taskId}/comments/${created.id}`, { method: "DELETE" }),
  );
  expect(deleted.status).toBe(200);

  // Appending to a missing task 404s.
  const missing = await app.handle(
    new Request(`${base}/tasks/999999/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "into the void" }),
    }),
  );
  expect(missing.status).toBe(404);
});
