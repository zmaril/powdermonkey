import { eq, isNull } from "drizzle-orm";
import { db } from "./db.ts";
import {
  type Goal,
  goals,
  type Milestone,
  milestones,
  type Note,
  notes,
  type Phase,
  phases,
  type Repo,
  repos,
  type Session,
  sessions,
  type Task,
  tasks,
} from "./schema.ts";

// Generic CRUD over any of the vocab tables. Every table shares `id`, `archived_at`,
// and `updated_at`, so one factory covers all five. `archive` is the soft delete:
// it sets archived_at instead of removing the row, and lists exclude archived rows
// unless explicitly asked for.

// biome-ignore lint/suspicious/noExplicitAny: tables share the shape this relies on.
type AnyTable = any;

function crud<TSelect, TInsert extends Record<string, unknown>>(table: AnyTable) {
  return {
    list(opts?: { includeArchived?: boolean }): Promise<TSelect[]> {
      const q = db.select().from(table);
      return (opts?.includeArchived ? q : q.where(isNull(table.archivedAt))) as Promise<TSelect[]>;
    },
    async get(id: number): Promise<TSelect | undefined> {
      const rows = (await db.select().from(table).where(eq(table.id, id))) as TSelect[];
      return rows[0];
    },
    async create(values: TInsert): Promise<TSelect> {
      const rows = (await db.insert(table).values(values).returning()) as TSelect[];
      return rows[0];
    },
    async update(id: number, values: Partial<TInsert>): Promise<TSelect | undefined> {
      const rows = (await db
        .update(table)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(table.id, id))
        .returning()) as TSelect[];
      return rows[0];
    },
    async archive(id: number): Promise<TSelect | undefined> {
      const rows = (await db
        .update(table)
        .set({ archivedAt: new Date(), updatedAt: new Date() })
        .where(eq(table.id, id))
        .returning()) as TSelect[];
      return rows[0];
    },
    async restore(id: number): Promise<TSelect | undefined> {
      const rows = (await db
        .update(table)
        .set({ archivedAt: null, updatedAt: new Date() })
        .where(eq(table.id, id))
        .returning()) as TSelect[];
      return rows[0];
    },
  };
}

export const goalRepo = crud<Goal, typeof goals.$inferInsert>(goals);
export const milestoneRepo = crud<Milestone, typeof milestones.$inferInsert>(milestones);
export const taskRepo = crud<Task, typeof tasks.$inferInsert>(tasks);
export const phaseRepo = crud<Phase, typeof phases.$inferInsert>(phases);
export const sessionRepo = crud<Session, typeof sessions.$inferInsert>(sessions);
export const noteRepo = crud<Note, typeof notes.$inferInsert>(notes);
export const repoRepo = crud<Repo, typeof repos.$inferInsert>(repos);
