import { beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The task's diary: one-line comments on a task. Capture is zero-ceremony (append,
// auto-timestamped, read back oldest-first) and a line stays an ordinary row after
// that: it can be edited in place (PATCH) and archived (soft delete, hidden from the
// list). Every mutation is scoped to the comment's task. Runs against a throwaway
// PGlite store, like the other DB-touching suites.
process.env.PM_DATA_DIR = join(mkdtempSync(join(tmpdir(), "pm-")), "pg");
const { ready } = await import("../src/server/db.ts");
const { loadPlan } = await import("../src/server/plan.ts");
const { appendComment, archiveComment, listComments, updateComment } = await import(
  "../src/server/comments.ts"
);
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
  expect(rows.map((r) => r.body)).toEqual([
    "first mutter",
    "operator was unsure here",
    "a later line",
  ]);
  const times = rows.map((r) => r.createdAt.getTime());
  expect([...times].sort((a, b) => a - b)).toEqual(times);
});

test("append to a task that doesn't exist is a clean null (404 at the route)", async () => {
  expect(await appendComment(999_999, "into the void")).toBeNull();
});

test("edit fixes a line in place, scoped to its task", async () => {
  const row = await appendComment(taskId, "a typoo");
  if (!row) throw new Error("append failed");
  // A wrong-task id can't edit across diaries.
  expect(await updateComment(taskId + 1, row.id, "nope")).toBeNull();
  const edited = await updateComment(taskId, row.id, "a typo, fixed");
  expect(edited?.body).toBe("a typo, fixed");
  // The edit stamps updated_at; created_at (and so the diary's order) is untouched.
  expect(edited && edited.updatedAt.getTime() >= edited.createdAt.getTime()).toBe(true);
  expect(edited?.createdAt.getTime()).toBe(row.createdAt.getTime());
  await archiveComment(taskId, row.id);
});

test("archive hides a line from the list without destroying the row", async () => {
  const row = await appendComment(taskId, "on second thought");
  if (!row) throw new Error("append failed");
  // A wrong-task id can't archive across diaries.
  expect(await archiveComment(taskId + 1, row.id)).toBeNull();
  const gone = await archiveComment(taskId, row.id);
  expect(gone?.id).toBe(row.id);
  expect(gone?.archivedAt).toBeInstanceOf(Date);
  expect((await listComments(taskId)).some((c) => c.id === row.id)).toBe(false);
});

test("routes: append + list + edit + archive", async () => {
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

  // PATCH edits the line in place.
  const patched = await app.handle(
    new Request(`${base}/tasks/${taskId}/comments/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "via the API, reworded" }),
    }),
  );
  expect(patched.status).toBe(200);
  expect(((await patched.json()) as { body: string }).body).toBe("via the API, reworded");

  // DELETE archives (soft) — the line leaves the list.
  const deleted = await app.handle(
    new Request(`${base}/tasks/${taskId}/comments/${created.id}`, { method: "DELETE" }),
  );
  expect(deleted.status).toBe(200);
  const after = (await (
    await app.handle(new Request(`${base}/tasks/${taskId}/comments`))
  ).json()) as Array<{ id: number }>;
  expect(after.some((r) => r.id === created.id)).toBe(false);

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
