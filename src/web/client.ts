import { treaty } from "@elysiajs/eden";
// Type-only import — erased by the bundler, so the server module (Elysia, Drizzle,
// Playwright) never enters the browser bundle while the types still flow through.
import type { App } from "../server/app.ts";
import { httpOrigin } from "./server.ts";

// The supervisor we talk to: same-origin by default (it serves this bundle), or a
// configured remote one for a desktop/remote client (see server.ts). A full
// scheme-qualified origin — treaty would otherwise force https:// onto a bare
// non-localhost host, breaking a plain-http Tailscale server.
const origin = typeof window !== "undefined" ? httpOrigin() : "http://localhost:4500";

export const api = treaty<App>(origin);
