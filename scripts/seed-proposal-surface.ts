#!/usr/bin/env bun
// Seed a plan plus one proposal that touches every proposal-review surface in the
// Backlog, so the proposal UI can be exercised (and screenshotted under each theme —
// see screenshot-backlog-themes.ts). One change-set that produces, in place:
//   • a ghost task card  (create task + child phases → GhostCardBody)
//   • a ghost milestone   (create milestone → GhostHeader)
//   • a rename / delete / move strip on real cards (update / archive / reorder)
//   • an add-phase strip  (create phase under an existing task)
// Point it at a running supervisor: PM_URL=http://localhost:4500 bun run
// scripts/seed-proposal-surface.ts

const PM_URL = process.env.PM_URL ?? "http://localhost:4500";

async function post(path: string, body: unknown): Promise<unknown> {
  const r = await fetch(`${PM_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`POST ${path} → ${r.status} ${await r.text()}`);
  return r.json();
}

type Row = { id: number; title: string; goalId?: number };

async function get(path: string): Promise<Row[]> {
  const r = await fetch(`${PM_URL}${path}`);
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}`);
  return r.json() as Promise<Row[]>;
}

// A plan with four tasks: one to grow a phase on, one each to rename / delete / move.
await post("/plan", {
  goals: [
    {
      title: "Ship the proposal review UI",
      objective: "Make every proposed change reviewable in place",
      milestones: [
        {
          title: "Backlog surface",
          tasks: [
            {
              title: "Render ghost cards",
              phases: [{ name: "layout" }, { name: "wire accept/reject" }],
            },
            { title: "Rename me task", phases: [{ name: "draft" }, { name: "polish" }] },
            { title: "Delete me task", phases: [{ name: "old phase" }] },
            { title: "Move me task", phases: [{ name: "step one" }] },
          ],
        },
      ],
    },
  ],
});

// Resolve the ids the proposal needs to act on (first milestone + its tasks).
const milestones = await get("/milestones");
const tasks = await get("/tasks");
const milestoneId = milestones[0].id;
const byTitle = (title: string): number => {
  const row = tasks.find((x) => x.title === title);
  if (!row) throw new Error(`no task titled "${title}"`);
  return row.id;
};

await post("/proposals", {
  title: "Reshape the backlog",
  summary: "A change-set touching every proposal surface",
  changes: [
    // Ghost task card (+ its phase checklist).
    {
      op: "create",
      kind: "task",
      parentId: milestoneId,
      ref: "newtask",
      fields: { title: "Proposed new task with phases" },
    },
    { op: "create", kind: "phase", parentRef: "newtask", fields: { name: "ghost phase one" } },
    { op: "create", kind: "phase", parentRef: "newtask", fields: { name: "ghost phase two" } },
    // Ghost milestone (GhostHeader).
    {
      op: "create",
      kind: "milestone",
      parentId: milestones[0].goalId,
      fields: { title: "Proposed new milestone" },
    },
    // Rename / delete / move strips on real cards.
    {
      op: "update",
      kind: "task",
      id: byTitle("Rename me task"),
      fields: { title: "Renamed task title" },
    },
    { op: "archive", kind: "task", id: byTitle("Delete me task") },
    { op: "reorder", kind: "task", id: byTitle("Move me task"), position: 0 },
    // Add-phase strip on an existing task.
    {
      op: "create",
      kind: "phase",
      parentId: byTitle("Render ghost cards"),
      fields: { name: "added phase on task 1" },
    },
  ],
});

console.log(`seeded plan + proposal at ${PM_URL} — open the Backlog to review.`);
