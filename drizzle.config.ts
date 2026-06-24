import { defineConfig } from "drizzle-kit";

// Postgres dialect so the schema + generated migrations are portable from PGlite
// (embedded) to a real Postgres. `bun run db:generate` writes SQL into ./drizzle;
// the server applies it at boot via the PGlite migrator.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/schema.ts",
  out: "./drizzle",
});
