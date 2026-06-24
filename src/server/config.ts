// Centralized config: every environment knob in one place. (PM_DB_DIR is the
// exception — db.ts reads it lazily so tests can point at an in-memory DB.)

import { homedir } from "node:os";

export const PORT = Number(process.env.PORT ?? 4500);

/** Public base URL the worker token links point at. */
export const BASE_URL = process.env.PUBLIC_URL ?? `http://localhost:${PORT}`;

/** Where per-task git worktrees live (sibling of the repos). */
export const WORKTREE_ROOT = process.env.PM_WORKTREE_ROOT ?? `${homedir()}/.powdermonkey/worktrees`;

/** Test overrides: substitute a fake worker / planner instead of `claude -p`. */
export const WORKER_CMD = process.env.PM_WORKER_CMD;
export const SUPERVISOR_CMD = process.env.PM_SUPERVISOR_CMD;
