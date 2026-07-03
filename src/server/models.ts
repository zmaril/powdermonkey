import { type TObject, type TSchema, Type } from "@sinclair/typebox";
import { createInsertSchema } from "drizzle-typebox";
import { TaskKind } from "../shared/types.ts";
import { goals, milestones, notes, phases, repos, sessions, tasks } from "./schema.ts";

// drizzle-typebox's insert schema carries a very deep generic type. Pinning it to a
// plain TObject stops TS from unrolling it (TS2589) — the runtime schema object,
// which is what Elysia actually validates against, is unchanged.
// biome-ignore lint/suspicious/noExplicitAny: type-only truncation; runtime intact.
const insert = (table: any, refine?: Record<string, () => TSchema>): TObject =>
  createInsertSchema(table, refine) as unknown as TObject;

// The closed TaskKind vocabulary as a TypeBox schema, for every route body that
// accepts a kind (task create/update via the refine below, fan-out, the plan loader).
// A text column reads as plain Type.String out of drizzle-typebox, so without this a
// PATCH could write any word into tasks.kind.
export const taskKindSchema = Type.Union([
  Type.Literal(TaskKind.Task),
  Type.Literal(TaskKind.Bug),
  Type.Literal(TaskKind.Spike),
]);

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
// Refined as a callback so drizzle-typebox still applies its optionality wrapping
// (kind has a default, so it stays optional in the create body).
const taskCreate = Type.Omit(insert(tasks, { kind: () => taskKindSchema }), SERVER_MANAGED);
const phaseCreate = Type.Omit(insert(phases), SERVER_MANAGED);
const sessionCreate = Type.Omit(insert(sessions), SERVER_MANAGED);
const noteCreate = Type.Omit(insert(notes), SERVER_MANAGED);
const repoCreate = Type.Omit(insert(repos), SERVER_MANAGED);

// Updates: same fields, all optional (PATCH semantics).
export const models = {
  goals: { create: goalCreate, update: Type.Partial(goalCreate) },
  milestones: { create: milestoneCreate, update: Type.Partial(milestoneCreate) },
  tasks: { create: taskCreate, update: Type.Partial(taskCreate) },
  phases: { create: phaseCreate, update: Type.Partial(phaseCreate) },
  sessions: { create: sessionCreate, update: Type.Partial(sessionCreate) },
  notes: { create: noteCreate, update: Type.Partial(noteCreate) },
  repos: { create: repoCreate, update: Type.Partial(repoCreate) },
};
