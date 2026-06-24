// End-to-end type-safe client generated from the server's routes via Eden
// Treaty. `import type { App }` is erased at build time — no server code ships
// to the browser — but the call sites are fully typed and a route change becomes
// a compile error here. Replaces the old hand-written fetch wrappers.

import { treaty } from "@elysiajs/eden";
import type { App } from "../server/index.ts";

export const api = treaty<App>(
  typeof window !== "undefined" ? window.location.host : "localhost:4500",
);
