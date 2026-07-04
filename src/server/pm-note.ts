// The PM-Note trailer: ONE structured JSON object per commit carrying everything a
// worker signals about the work that commit finished — phases done, the whole task
// done, and follow-ups handed back. It unifies what used to be two split channels
// (`PM-Phase:` / `PM-Task:` trailers for completion + a `<!-- pm:followup -->` PR
// comment for each hand-back) into a single line in the commit MESSAGE:
//
//   PM-Note: {"v":1,"phases":[41,42],"task":40,"followups":[{"title":"…","body":"…"}]}
//
// Why a message trailer and not a real git note (refs/notes/*): a cloud
// (`claude --remote`) worker CANNOT push a notes ref — the Claude Code git proxy
// 403s any push to a non-branch ref — and even where a note can be pushed it doesn't
// survive a squash merge (the squash rewrites the commit SHA and orphans the note).
// A trailer rides the ordinary branch push and is concatenated into a squash
// commit's body, so it survives both the proxy and any merge strategy. The full
// spike that established this is docs/git-notes-spike.md.
//
// `PM-Phase:` / `PM-Task:` trailers stay readable as a LEGACY fallback during
// cutover (see reconcile.ts / github-watch.ts); this module is the new primary.

/** A follow-up a worker hands back — an out-of-scope find the operator triages into
 *  the plan (the same pending-proposal flow as any follow-up). `title` is the
 *  one-liner; `body` is optional context. */
export type PmFollowup = { title: string; body?: string };

/** One parsed, normalized PM-Note. Every list defaults to empty and `task` to null,
 *  so a caller can read a field without guarding — an absent field just reads as
 *  "nothing of this kind". `v` is the payload schema version (currently 1). */
export type PmNote = {
  v: number;
  /** Phase ids this commit finished (deduped, order preserved). */
  phases: number[];
  /** A task id this commit finished outright (the PM-Task shortcut), or null. */
  task: number | null;
  /** Follow-ups handed back on this commit. */
  followups: PmFollowup[];
};

/** The commit-message trailer key. A line `PM-Note: <json>` carries the payload. */
export const PM_NOTE_KEY = "PM-Note";
/** The current payload schema version stamped into `v`. */
export const PM_NOTE_VERSION = 1;

// One trailer per line: everything after `PM-Note:` up to the newline is the JSON
// payload (JSON has no bare newlines — a multi-line follow-up body is `\n`-escaped —
// so a single line always holds a whole object). Case-insensitive on the key to
// match how git trailers are usually treated; `m` so it finds the trailer anywhere
// in a multi-commit body (the reconcile scan concatenates many messages).
const NOTE_LINE = /^[ \t]*PM-Note:[ \t]*(.+?)[ \t]*$/gim;

/** Positive-integer guard shared by phase/task normalization. */
function posInt(x: unknown): number | null {
  return typeof x === "number" && Number.isInteger(x) && x > 0 ? x : null;
}

/** Normalize `phases`, accepting a single number or an array; keep positive ints,
 *  dedup, preserve first-seen order. Anything else falls away to []. */
function normPhases(raw: unknown): number[] {
  const arr = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  const out: number[] = [];
  for (const x of arr) {
    const n = posInt(x);
    if (n != null && !out.includes(n)) out.push(n);
  }
  return out;
}

/** Normalize `followups`: keep only entries with a non-empty trimmed `title`; carry
 *  an optional trimmed `body`. Tolerant of a bare string ("just the title"). */
function normFollowups(raw: unknown): PmFollowup[] {
  if (!Array.isArray(raw)) return [];
  const out: PmFollowup[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      const title = item.trim();
      if (title) out.push({ title });
      continue;
    }
    if (item && typeof item === "object") {
      const title =
        typeof (item as { title?: unknown }).title === "string"
          ? (item as { title: string }).title.trim()
          : "";
      if (!title) continue;
      const bodyRaw = (item as { body?: unknown }).body;
      const body = typeof bodyRaw === "string" ? bodyRaw.trim() : "";
      out.push(body ? { title, body } : { title });
    }
  }
  return out;
}

/** True when a note carries no actionable signal at all — no phases, no task, no
 *  follow-ups. Such a note is noise and is dropped by the parser. */
function isEmpty(n: PmNote): boolean {
  return n.phases.length === 0 && n.task == null && n.followups.length === 0;
}

/** Parse every `PM-Note:` trailer out of commit-message text into normalized notes.
 *  `text` may be one commit body or many concatenated (the reconcile scan passes the
 *  whole `git log` output). Forgiving by design — a line whose JSON doesn't parse, or
 *  parses to a non-object, or carries no usable signal, is skipped rather than
 *  throwing, so one malformed note never breaks a reconcile pass. Pure. */
export function parsePmNotes(text: string): PmNote[] {
  const notes: PmNote[] = [];
  for (const m of text.matchAll(NOTE_LINE)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(m[1]);
    } catch {
      continue; // not JSON — skip
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const obj = parsed as Record<string, unknown>;
    const note: PmNote = {
      v: posInt(obj.v) ?? PM_NOTE_VERSION,
      phases: normPhases(obj.phases),
      task: posInt(obj.task),
      followups: normFollowups(obj.followups),
    };
    if (!isEmpty(note)) notes.push(note);
  }
  return notes;
}

/** Render a PM-Note as its commit-message trailer line (no trailing newline). The
 *  inverse of `parsePmNotes` for a single note — used by the worker brief's example
 *  and by tests. Empty/absent fields are omitted to keep the payload tight; `v` is
 *  always stamped. Pure. */
export function formatPmNote(note: Partial<Pick<PmNote, "phases" | "task" | "followups">>): string {
  const payload: Record<string, unknown> = { v: PM_NOTE_VERSION };
  const phases = normPhases(note.phases);
  if (phases.length) payload.phases = phases;
  const task = posInt(note.task ?? null);
  if (task != null) payload.task = task;
  const followups = normFollowups(note.followups);
  if (followups.length) payload.followups = followups;
  return `${PM_NOTE_KEY}: ${JSON.stringify(payload)}`;
}
