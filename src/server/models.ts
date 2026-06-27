import { type TObject, Type } from "@sinclair/typebox";
import { createInsertSchema } from "drizzle-typebox";
import { goals, milestones, phases, sessions, tasks } from "./schema.ts";

// drizzle-typebox's insert schema carries a very deep generic type. Pinning it to a
// plain TObject stops TS from unrolling it (TS2589) — the runtime schema object,
// which is what Elysia actually validates against, is unchanged.
// biome-ignore lint/suspicious/noExplicitAny: type-only truncation; runtime intact.
const insert = (table: any): TObject => createInsertSchema(table) as unknown as TObject;

// Request body schemas derived straight from the Drizzle tables via drizzle-typebox.
// Elysia is TypeBox-native, so these plug directly into route `body` validators and
// stay in sync with schema.ts automatically — no hand-maintained shapes.
//
// createInsertSchema already drops the generated `id` and makes defaulted/nullable
// columns optional. We additionally omit the server-managed columns so a client
// can't set timestamps or archive state through create/update.
const SERVER_MANAGED = ["createdAt", "updatedAt", "archivedAt"] as const;

const goalCreate = Type.Omit(insert(goals), SERVER_MANAGED);
const milestoneCreate = Type.Omit(insert(milestones), SERVER_MANAGED);
const taskCreate = Type.Omit(insert(tasks), SERVER_MANAGED);
const phaseCreate = Type.Omit(insert(phases), SERVER_MANAGED);
const sessionCreate = Type.Omit(insert(sessions), SERVER_MANAGED);

// Updates: same fields, all optional (PATCH semantics).
export const models = {
  goals: { create: goalCreate, update: Type.Partial(goalCreate) },
  milestones: { create: milestoneCreate, update: Type.Partial(milestoneCreate) },
  tasks: { create: taskCreate, update: Type.Partial(taskCreate) },
  phases: { create: phaseCreate, update: Type.Partial(phaseCreate) },
  sessions: { create: sessionCreate, update: Type.Partial(sessionCreate) },
};
