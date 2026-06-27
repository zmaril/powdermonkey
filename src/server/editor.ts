import { eq } from "drizzle-orm";
import { db } from "./db.ts";
import { sessions, tasks } from "./schema.ts";

// Open a session's work in VS Code on the operator's machine. The supervisor runs
// locally, so it can spawn GUI apps directly. A `local` session opens its git
// worktree in desktop VS Code (`code <path>`). A `remote` session has no local
// checkout, so we open its PR in github.dev — GitHub's in-browser build of VS Code
// — by swapping the host; no clone or extension needed.

const CODE_BIN = process.env.PM_CODE_BIN ?? "code";

// OS URL opener (PM_OPEN_URL_CMD overrides). github.dev is just a URL, so the
// platform opener hands it to the default browser.
function urlOpener(): string {
  if (process.env.PM_OPEN_URL_CMD) return process.env.PM_OPEN_URL_CMD;
  if (process.platform === "darwin") return "open";
  if (process.platform === "win32") return "start";
  return "xdg-open";
}

export type OpenEditorResult = { ok: true; target: string } | { ok: false; error: string };

/** Fire-and-forget GUI launch; never block the HTTP request on the editor. */
function spawnDetached(cmd: string[]): void {
  Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
}

export async function openSessionEditor(sessionId: number): Promise<OpenEditorResult> {
  const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
  if (!session) return { ok: false, error: `unknown session "${sessionId}"` };

  if (session.kind === "local") {
    if (!session.worktreePath) return { ok: false, error: "session has no worktree" };
    spawnDetached([CODE_BIN, session.worktreePath]);
    return { ok: true, target: session.worktreePath };
  }

  // remote: open the task's PR in github.dev (web VS Code).
  const [task] =
    session.taskId != null ? await db.select().from(tasks).where(eq(tasks.id, session.taskId)) : [];
  if (!task?.prUrl) return { ok: false, error: "no PR for this task yet" };
  const target = task.prUrl.replace("://github.com/", "://github.dev/");
  spawnDetached([urlOpener(), target]);
  return { ok: true, target };
}
