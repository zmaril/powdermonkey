import { treaty } from "@elysiajs/eden";
// Type-only import — erased by the bundler, so the server module (Elysia, Drizzle,
// Playwright) never enters the browser bundle while the types still flow through.
import type { App } from "../server/app.ts";

// Same origin: the supervisor serves both the API and this bundle.
const host = typeof window !== "undefined" ? window.location.host : "localhost:4500";

export const api = treaty<App>(host);
