// The repository: the live entity tables are the source of truth. Every mutation
// goes through here, writing the row and appending one `actions` row with the
// field-level diff (before→after). Control flow is Effect: writes are serialized
// with a Semaphore, run inside a `begin`/`commit`/`rollback` transaction via
// `acquireUseRelease` (auto-rollback on failure/interruption), and surface a
// typed `RepoError`. Drizzle stays for the schema, queries, types, and migrations.

import { and, desc, eq, gt, inArray, isNotNull, isNull, max, sql } from "drizzle-orm";
import { Effect, Exit, Match } from "effect";
import type { Artifact, BoardColumn, BoardState, TaskStatus } from "../shared/types.ts";
import { db } from "./db.ts";
import { RepoError } from "./fx/errors.ts";
import type { ActionName, Actor, EntityType } from "./schema.ts";
import {
  actions,
  artifacts,
  claims,
  goals,
  milestones,
  plans,
  scratchpad,
  sessions,
  tasks,
  workspaces,
  workstreams,
} from "./schema.ts";

// ---- ids + monotonic action seq ----
let seqCounter = 0;
function genId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// A DB call as Effect — the one unavoidable Promise→Effect boundary.
const tryE = <A>(op: string, f: () => Promise<A>): Effect.Effect<A, RepoError> =>
  Effect.tryPromise({ try: f, catch: (cause) => new RepoError({ op, cause }) });

export const initRepo = (): Promise<void> =>
  Effect.runPromise(
    tryE("initRepo", () =>
      db()
        .select({ m: max(actions.seq) })
        .from(actions)
        .then((r) => r[0]?.m ?? 0),
    ).pipe(
      Effect.tap((m) =>
        Effect.sync(() => {
          seqCounter = m;
        }),
      ),
      Effect.catchAll(() => Effect.void),
      Effect.asVoid,
    ),
  );

// ---- change notification (drives the WS feed) ----
export interface ActionRecord {
  id: string;
  seq: number;
  at: string; // ISO 8601
  actor: Actor;
  action: ActionName;
  entityType: EntityType;
  entityId: string;
  summary: string | null;
  diff: Record<string, { from: unknown; to: unknown }>;
}

const subscribers = new Set<(a: ActionRecord) => void>();
export function subscribe(fn: (a: ActionRecord) => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}
function notify(action: ActionRecord): void {
  for (const fn of subscribers) {
    try {
      fn(action);
    } catch {
      /* a subscriber must not break a mutation */
    }
  }
}

// ---- diff (pure) ----
function ser(v: unknown): unknown {
  return v instanceof Date ? v.toISOString() : v;
}
function valEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a == null || b == null) return a == null && b == null;
  if (typeof a === "object" && typeof b === "object")
    return JSON.stringify(a) === JSON.stringify(b);
  return false;
}
function computeDiff(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): Record<string, { from: unknown; to: unknown }> {
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const k of keys) {
    const a = before?.[k];
    const b = after?.[k];
    if (!valEq(a, b)) diff[k] = { from: ser(a) ?? null, to: ser(b) ?? null };
  }
  return diff;
}

export interface Meta {
  actor: Actor;
  action: ActionName;
  summary?: string | null;
}

// ---- write machinery (Effect) ----
// Serialize all writes so a read-then-write can't interleave and diff against
// stale state. An Effect Semaphore replaces the old promise chain.
const writeLock = Effect.runSync(Effect.makeSemaphore(1));
const serialized = <A, E>(e: Effect.Effect<A, E>) => writeLock.withPermits(1)(e);

const exec = (q: ReturnType<typeof sql>) => tryE("exec", () => db().execute(q));

// Run `use` inside a transaction; commit on success, rollback on failure/interruption.
const transaction = <A, E>(use: Effect.Effect<A, E>): Effect.Effect<A, E | RepoError> =>
  Effect.acquireUseRelease(
    exec(sql`begin`),
    () => use,
    (_, exit) =>
      (Exit.isFailure(exit) ? exec(sql`rollback`) : exec(sql`commit`)).pipe(
        Effect.catchAll((e) => Effect.logError(`transaction finalize failed: ${String(e.cause)}`)),
      ),
  );

function mkAction(
  entityType: EntityType,
  entityId: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  meta: Meta,
): { record: ActionRecord; at: Date } {
  const at = new Date();
  return {
    at,
    record: {
      id: genId("act"),
      seq: ++seqCounter,
      at: at.toISOString(),
      actor: meta.actor,
      action: meta.action,
      entityType,
      entityId,
      summary: meta.summary ?? null,
      diff: computeDiff(before, after),
    },
  };
}

// biome-ignore lint/suspicious/noExplicitAny: generic over any table; wrappers below are typed.
function insertRow(table: any, entityType: EntityType, values: any, meta: Meta) {
  return serialized(
    Effect.gen(function* () {
      const now = new Date();
      const row = { ...values, createdAt: now, updatedAt: now };
      const { record, at } = mkAction(entityType, values.id, null, row, meta);
      yield* transaction(
        Effect.gen(function* () {
          yield* tryE("insert", () => db().insert(table).values(row));
          yield* tryE("insertAction", () =>
            db()
              .insert(actions)
              .values({ ...record, at }),
          );
        }),
      );
      yield* Effect.sync(() => notify(record));
      return row;
    }),
  );
}

// biome-ignore lint/suspicious/noExplicitAny: generic over any table; wrappers below are typed.
function updateRow(table: any, entityType: EntityType, id: string, patch: any, meta: Meta) {
  return serialized(
    Effect.gen(function* () {
      const before = yield* tryE("selectBefore", () =>
        db()
          .select()
          .from(table)
          .where(eq(table.id, id))
          .then((r) => r[0]),
      );
      if (!before) return null;
      const updatedAt = new Date();
      const next = { ...before, ...patch, updatedAt };
      const { record, at } = mkAction(entityType, id, before, next, meta);
      yield* transaction(
        Effect.gen(function* () {
          yield* tryE("update", () =>
            db()
              .update(table)
              .set({ ...patch, updatedAt })
              .where(eq(table.id, id)),
          );
          yield* tryE("insertAction", () =>
            db()
              .insert(actions)
              .values({ ...record, at }),
          );
        }),
      );
      yield* Effect.sync(() => notify(record));
      return next;
    }),
  );
}

// ---- typed entity operations (each returns an Effect) ----
export const createWorkspace = (v: typeof workspaces.$inferInsert, m: Meta) =>
  insertRow(workspaces, "workspace", v, m);
export const updateWorkspace = (id: string, p: Partial<typeof workspaces.$inferInsert>, m: Meta) =>
  updateRow(workspaces, "workspace", id, p, m);
export const archiveWorkspace = (id: string, m: Meta) =>
  updateRow(workspaces, "workspace", id, { archivedAt: new Date() }, m);
export const restoreWorkspace = (id: string, m: Meta) =>
  updateRow(workspaces, "workspace", id, { archivedAt: null }, m);
export const createGoal = (v: typeof goals.$inferInsert, m: Meta) => insertRow(goals, "goal", v, m);
export const archiveGoal = (id: string, m: Meta) =>
  updateRow(goals, "goal", id, { archivedAt: new Date() }, m);
export const restoreGoal = (id: string, m: Meta) =>
  updateRow(goals, "goal", id, { archivedAt: null }, m);
export const createPlan = (v: typeof plans.$inferInsert, m: Meta) => insertRow(plans, "plan", v, m);
export const updatePlan = (id: string, p: Partial<typeof plans.$inferInsert>, m: Meta) =>
  updateRow(plans, "plan", id, p, m);
export const createWorkstream = (v: typeof workstreams.$inferInsert, m: Meta) =>
  insertRow(workstreams, "workstream", v, m);
export const createMilestone = (v: typeof milestones.$inferInsert, m: Meta) =>
  insertRow(milestones, "milestone", v, m);
export const updateMilestone = (id: string, p: Partial<typeof milestones.$inferInsert>, m: Meta) =>
  updateRow(milestones, "milestone", id, p, m);
export const archiveMilestone = (id: string, m: Meta) =>
  updateRow(milestones, "milestone", id, { archivedAt: new Date() }, m);
export const restoreMilestone = (id: string, m: Meta) =>
  updateRow(milestones, "milestone", id, { archivedAt: null }, m);

// Approve the active/awaiting milestone: mark it done, then promote the next
// pending milestone (lowest orderHint) in the same goal to active.
export const approveMilestone = (id: string, m: Meta) =>
  Effect.gen(function* () {
    const done = (yield* updateMilestone(id, { status: "done" }, m)) as { goalId: string } | null;
    if (!done) return null;
    const next = yield* tryE("nextPending", () =>
      db()
        .select()
        .from(milestones)
        .where(
          and(
            eq(milestones.goalId, done.goalId),
            isNull(milestones.archivedAt),
            eq(milestones.status, "pending"),
          ),
        )
        .orderBy(milestones.orderHint)
        .limit(1)
        .then((r) => r[0]),
    );
    if (next) {
      yield* updateMilestone(
        next.id,
        { status: "active" },
        { actor: m.actor, action: "milestone_started", summary: next.title },
      );
    }
    return done;
  });

export const nextMilestoneOrder = (goalId: string) =>
  tryE("nextMilestoneOrder", () =>
    db()
      .select({ o: milestones.orderHint })
      .from(milestones)
      .where(and(eq(milestones.goalId, goalId), isNull(milestones.archivedAt)))
      .orderBy(desc(milestones.orderHint))
      .limit(1)
      .then((r) => (r[0]?.o ?? -1) + 1),
  );

export const activeMilestoneId = (goalId: string) =>
  tryE("activeMilestoneId", () =>
    db()
      .select({ id: milestones.id })
      .from(milestones)
      .where(
        and(
          eq(milestones.goalId, goalId),
          isNull(milestones.archivedAt),
          eq(milestones.status, "active"),
        ),
      )
      .limit(1)
      .then((r) => r[0]?.id ?? null),
  );

export const createTask = (v: typeof tasks.$inferInsert, m: Meta) => insertRow(tasks, "task", v, m);
export const updateTask = (id: string, p: Partial<typeof tasks.$inferInsert>, m: Meta) =>
  updateRow(tasks, "task", id, p, m);
export const archiveTask = (id: string, m: Meta) =>
  updateRow(tasks, "task", id, { archivedAt: new Date() }, m);
export const restoreTask = (id: string, m: Meta) =>
  updateRow(tasks, "task", id, { archivedAt: null }, m);
export const createSession = (v: typeof sessions.$inferInsert, m: Meta) =>
  insertRow(sessions, "session", v, m);
export const updateSession = (id: string, p: Partial<typeof sessions.$inferInsert>, m: Meta) =>
  updateRow(sessions, "session", id, p, m);
export const createArtifact = (v: typeof artifacts.$inferInsert, m: Meta) =>
  insertRow(artifacts, "artifact", v, m);
export const createClaim = (v: typeof claims.$inferInsert, m: Meta) =>
  insertRow(claims, "claim", v, m);

// ---- reads (each returns an Effect) ----
const one = <T>(op: string, q: () => Promise<T[]>) => tryE(op, () => q().then((r) => r[0] ?? null));

export const getTask = (id: string) =>
  one("getTask", () => db().select().from(tasks).where(eq(tasks.id, id)));
export const getWorkspace = (id: string) =>
  one("getWorkspace", () => db().select().from(workspaces).where(eq(workspaces.id, id)));
export const getGoal = (id: string) =>
  one("getGoal", () => db().select().from(goals).where(eq(goals.id, id)));
export const getPlan = (id: string) =>
  one("getPlan", () => db().select().from(plans).where(eq(plans.id, id)));
export const getSession = (id: string) =>
  one("getSession", () => db().select().from(sessions).where(eq(sessions.id, id)));

// Resolve a task's owning Workspace (task → workstream → goal → workspace).
export const workspaceForTask = (
  taskId: string,
): Effect.Effect<typeof workspaces.$inferSelect | null, RepoError> =>
  Effect.gen(function* () {
    const task = yield* getTask(taskId);
    if (!task?.workstreamId) return null;
    const ws = yield* one("ws", () =>
      db()
        .select()
        .from(workstreams)
        .where(eq(workstreams.id, task.workstreamId as string)),
    );
    if (!ws) return null;
    const goal = yield* getGoal(ws.goalId);
    if (!goal) return null;
    return yield* getWorkspace(goal.workspaceId);
  });

export const tasksWithStatus = (statuses: TaskStatus[]) =>
  tryE("tasksWithStatus", () =>
    db()
      .select()
      .from(tasks)
      .where(and(isNull(tasks.archivedAt), inArray(tasks.status, statuses))),
  );

export const recentActions = (limit = 200) =>
  tryE("recentActions", () => db().select().from(actions).orderBy(desc(actions.seq)).limit(limit));

export const actionsForEntity = (entityType: EntityType, entityId: string, sinceSeq = 0) =>
  tryE("actionsForEntity", () =>
    db()
      .select()
      .from(actions)
      .where(
        and(
          eq(actions.entityType, entityType),
          eq(actions.entityId, entityId),
          gt(actions.seq, sinceSeq),
        ),
      )
      .orderBy(desc(actions.seq)),
  );

// Exhaustive over TaskStatus — add a status and this fails to compile until it
// is placed in a column (no silent default bucket).
function columnFor(status: TaskStatus): BoardColumn {
  return Match.value(status).pipe(
    Match.when(
      Match.is("waiting_for_me", "blocked", "failed", "needs_review"),
      () => "needs_input" as const,
    ),
    Match.when(Match.is("done", "abandoned"), () => "done" as const),
    Match.when(
      Match.is("planned", "launched", "working", "github_action"),
      () => "working" as const,
    ),
    Match.exhaustive,
  );
}

// ---- scratchpad ----
const SCRATCHPAD_ID = "main";
export const getScratchpad = (): Effect.Effect<string, RepoError> =>
  tryE("getScratchpad", () =>
    db()
      .select()
      .from(scratchpad)
      .where(eq(scratchpad.id, SCRATCHPAD_ID))
      .then((r) => r[0]?.content ?? ""),
  );

export const setScratchpad = (content: string, meta: Meta) =>
  serialized(
    Effect.gen(function* () {
      const now = new Date();
      const { record, at } = mkAction("scratchpad", SCRATCHPAD_ID, null, null, meta);
      yield* transaction(
        Effect.gen(function* () {
          yield* tryE("upsertScratchpad", () =>
            db()
              .insert(scratchpad)
              .values({ id: SCRATCHPAD_ID, content, createdAt: now, updatedAt: now })
              .onConflictDoUpdate({ target: scratchpad.id, set: { content, updatedAt: now } }),
          );
          yield* tryE("insertAction", () =>
            db()
              .insert(actions)
              .values({ ...record, at }),
          );
        }),
      );
      yield* Effect.sync(() => notify(record));
    }),
  );

// Archived (non-live) workspaces/goals/tasks/milestones — for the restore surface.
export const archivedEntities = () =>
  tryE("archivedEntities", async () => {
    const d = db();
    const strip = <T extends { createdAt: Date; updatedAt: Date; archivedAt: Date | null }>(
      r: T,
    ) => {
      const { createdAt, updatedAt, archivedAt, ...rest } = r;
      return { ...rest, archivedAt: archivedAt?.toISOString() ?? null };
    };
    const [p, g, t, ms] = await Promise.all([
      d.select().from(workspaces).where(isNotNull(workspaces.archivedAt)),
      d.select().from(goals).where(isNotNull(goals.archivedAt)),
      d.select().from(tasks).where(isNotNull(tasks.archivedAt)),
      d.select().from(milestones).where(isNotNull(milestones.archivedAt)),
    ]);
    return {
      workspaces: p.map((r) => ({
        id: r.id,
        name: r.name,
        archivedAt: r.archivedAt?.toISOString() ?? null,
      })),
      goals: g.map((r) => ({
        id: r.id,
        title: r.title,
        workspaceId: r.workspaceId,
        archivedAt: r.archivedAt?.toISOString() ?? null,
      })),
      tasks: t.map((r) => ({
        id: r.id,
        title: r.title,
        status: r.status,
        archivedAt: r.archivedAt?.toISOString() ?? null,
      })),
      milestones: ms.map((r) => ({
        id: r.id,
        title: r.title,
        goalId: r.goalId,
        archivedAt: r.archivedAt?.toISOString() ?? null,
      })),
    };
  });

// ---- board projection ----
export const getBoardState = (): Effect.Effect<BoardState, RepoError> =>
  tryE("getBoardState", async () => {
    const d = db();
    const [
      workspaceRows,
      goalRows,
      milestoneRows,
      planRows,
      wsRows,
      taskRows,
      sessionRows,
      artifactRows,
    ] = await Promise.all([
      d.select().from(workspaces).where(isNull(workspaces.archivedAt)),
      d.select().from(goals).where(isNull(goals.archivedAt)),
      d.select().from(milestones).where(isNull(milestones.archivedAt)),
      d.select().from(plans).where(isNull(plans.archivedAt)),
      d.select().from(workstreams).where(isNull(workstreams.archivedAt)),
      d.select().from(tasks).where(isNull(tasks.archivedAt)),
      d.select().from(sessions).where(isNull(sessions.archivedAt)),
      d.select().from(artifacts).where(isNull(artifacts.archivedAt)),
    ]);

    const artifactsByTask = new Map<string, Artifact[]>();
    for (const { createdAt, updatedAt, archivedAt, payload, ...a } of artifactRows) {
      const list = artifactsByTask.get(a.taskId) ?? [];
      list.push({ ...a, payload: payload ?? {}, at: createdAt.toISOString() });
      artifactsByTask.set(a.taskId, list);
    }

    return {
      seq: seqCounter,
      workspaces: workspaceRows.map(({ createdAt, updatedAt, archivedAt, ...p }) => p),
      goals: goalRows.map(({ createdAt, updatedAt, archivedAt, ...g }) => g),
      milestones: milestoneRows.map(({ createdAt, updatedAt, archivedAt, ...m }) => m),
      plans: planRows.map(({ createdAt, updatedAt, archivedAt, ...p }) => ({
        ...p,
        proposedTasks: p.proposedTasks ?? [],
      })),
      workstreams: wsRows.map(({ createdAt, updatedAt, archivedAt, ...w }) => w),
      sessions: sessionRows.map(({ createdAt, updatedAt, archivedAt, ...s }) => s),
      tasks: taskRows.map(({ createdAt, updatedAt, archivedAt, token, ...t }) => ({
        ...t,
        updatedAt: updatedAt.toISOString(),
        column: columnFor(t.status),
        artifacts: artifactsByTask.get(t.id) ?? [],
      })),
    };
  });
