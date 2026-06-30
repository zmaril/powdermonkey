import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// diffCloudPrs is the pure heart of the watcher — given last-seen PRs and a fresh
// fetch, decide what events to emit. No DB, no network: just the classification.
// Importing the module still transitively opens db.ts (subscribers use the task
// repo), so isolate it to a throwaway data dir to avoid the writer lock.
process.env.PM_DATA_DIR = join(mkdtempSync(join(tmpdir(), "pm-")), "pg");
const {
  diffCloudPrs,
  parseTrailerIds,
  parseStatusComment,
  statusFromComments,
  parseFollowupComment,
  rebaseAction,
} = await import("../src/server/github-watch.ts");
type CloudPr = import("../src/server/events.ts").CloudPr;

function pr(over: Partial<CloudPr> & { number: number; taskId: number }): CloudPr {
  return {
    title: `PR ${over.number}`,
    url: `https://github.com/o/r/pull/${over.number}`,
    state: "OPEN",
    isDraft: false,
    merged: false,
    checks: null,
    mergeable: null,
    headRefName: `pm/task-${over.taskId}-slug`,
    updatedAt: "2026-06-27T00:00:00Z",
    agent: null,
    followups: [],
    lastComment: null,
    lastCommentAt: null,
    lastCommentUrl: null,
    ...over,
  };
}

const index = (prs: CloudPr[]) => new Map(prs.map((p) => [p.number, p]));

test("first sight of an open PR → pr.opened", () => {
  const evs = diffCloudPrs(new Map(), [pr({ number: 1, taskId: 10 })]);
  expect(evs).toEqual([{ type: "pr.opened", pr: pr({ number: 1, taskId: 10 }) }]);
});

test("startup catch-up: a pre-existing merged PR replays as pr.merged, not opened", () => {
  const evs = diffCloudPrs(new Map(), [
    pr({ number: 7, taskId: 110, state: "MERGED", merged: true }),
  ]);
  expect(evs.map((e) => e.type)).toEqual(["pr.merged"]);
});

test("a pre-existing closed-unmerged PR replays as pr.closed", () => {
  const evs = diffCloudPrs(new Map(), [pr({ number: 9, taskId: 5, state: "CLOSED" })]);
  expect(evs.map((e) => e.type)).toEqual(["pr.closed"]);
});

test("unchanged PR emits nothing", () => {
  const prev = index([pr({ number: 1, taskId: 10 })]);
  expect(diffCloudPrs(prev, [pr({ number: 1, taskId: 10 })])).toEqual([]);
});

test("open → merged transition emits pr.merged once", () => {
  const prev = index([pr({ number: 1, taskId: 10 })]);
  const next = [pr({ number: 1, taskId: 10, state: "MERGED", merged: true })];
  expect(diffCloudPrs(prev, next).map((e) => e.type)).toEqual(["pr.merged"]);
});

test("draft → ready (and check state) emits pr.updated", () => {
  const prev = index([pr({ number: 1, taskId: 10, isDraft: true })]);
  const next = [pr({ number: 1, taskId: 10, isDraft: false, checks: "SUCCESS" })];
  expect(diffCloudPrs(prev, next).map((e) => e.type)).toEqual(["pr.updated"]);
});

test("open → closed without merge emits pr.closed", () => {
  const prev = index([pr({ number: 1, taskId: 10 })]);
  const next = [pr({ number: 1, taskId: 10, state: "CLOSED" })];
  expect(diffCloudPrs(prev, next).map((e) => e.type)).toEqual(["pr.closed"]);
});

test("parseTrailerIds pulls PM-Task and PM-Phase ids (the branch-name fallback)", () => {
  const body = [
    "CI: lint, format & tests",
    "",
    "PM-Phase: 142",
    "PM-Phase: 143, 144",
    "PM-Task: 105",
  ].join("\n");
  expect(parseTrailerIds(body)).toEqual({ taskIds: [105], phaseIds: [142, 143, 144] });
});

test("parseTrailerIds returns empties when there are no trailers", () => {
  expect(parseTrailerIds("just a normal commit message")).toEqual({ taskIds: [], phaseIds: [] });
});

test("parseStatusComment pulls the structured block out of the sticky comment", () => {
  const body = [
    "<!-- pm:status -->",
    "status: working",
    "summary: Wiring up the sticky status parser.",
    "next: Surface it on the Active panel.",
  ].join("\n");
  expect(parseStatusComment(body)).toEqual({
    state: "working",
    summary: "Wiring up the sticky status parser.",
    next: "Surface it on the Active panel.",
    sessionUrl: null,
    body: [
      "status: working",
      "summary: Wiring up the sticky status parser.",
      "next: Surface it on the Active panel.",
    ].join("\n"),
  });
});

test("parseStatusComment extracts the session link and keeps URL underscores intact", () => {
  const url = "https://claude.ai/code/session_015vrEiYejRQoSXGDL13FMy9";
  // bare URL
  expect(
    parseStatusComment(`<!-- pm:status -->\nstatus: working\nsession: ${url}`)?.sessionUrl,
  ).toBe(url);
  // tolerant of a markdown link / autolink wrapping the URL
  expect(parseStatusComment(`<!-- pm:status -->\nsession: [run](${url})`)?.sessionUrl).toBe(url);
  expect(parseStatusComment(`<!-- pm:status -->\nsession: <${url}>`)?.sessionUrl).toBe(url);
  // absent → null
  expect(parseStatusComment("<!-- pm:status -->\nstatus: working")?.sessionUrl).toBeNull();
});

test("parseStatusComment tolerates markdown formatting (bold / list markers)", () => {
  const body = [
    "<!-- pm:status -->",
    "- **status:** blocked",
    "- **summary:** Need a decision.",
  ].join("\n");
  const parsed = parseStatusComment(body);
  expect(parsed?.state).toBe("blocked");
  expect(parsed?.summary).toBe("Need a decision.");
  expect(parsed?.next).toBeNull();
});

test("parseStatusComment normalises a known state and nulls an unrecognised one", () => {
  // The parser is the validation seam: a known word (any case) → typed AgentState…
  expect(parseStatusComment("<!-- pm:status -->\nstatus: Starting")?.state).toBe("starting");
  // …a word outside AgentState → null (the raw text still rides in `body`).
  const odd = parseStatusComment("<!-- pm:status -->\nstatus: pondering");
  expect(odd?.state).toBeNull();
  expect(odd?.body).toContain("status: pondering");
});

test("parseStatusComment returns null for a comment without the marker", () => {
  expect(parseStatusComment("just a normal review comment\nstatus: working")).toBeNull();
});

test("statusFromComments takes the newest marked comment (append-only, newest-wins)", () => {
  // Comments arrive oldest→newest. Workers can't edit, so each update is a fresh
  // marked comment; the latest one is the live status and earlier ones are superseded.
  const comments = [
    { body: "<!-- pm:status -->\nstatus: starting\nsummary: booting", updatedAt: "t1" },
    { body: "just a human review comment", updatedAt: "t2" },
    { body: "<!-- pm:status -->\nstatus: working\nsummary: midway", updatedAt: "t3" },
    { body: "<!-- pm:status -->\nstatus: done\nsummary: ready for review", updatedAt: "t4" },
  ];
  const agent = statusFromComments(comments);
  expect(agent?.state).toBe("done");
  expect(agent?.summary).toBe("ready for review");
  expect(agent?.updatedAt).toBe("t4");
});

test("statusFromComments returns null when no comment carries the marker", () => {
  expect(statusFromComments([{ body: "lgtm", updatedAt: "t1" }])).toBeNull();
  expect(statusFromComments([])).toBeNull();
});

test("parseFollowupComment pulls a keyed title + body out of the marked comment", () => {
  const body = [
    "<!-- pm:followup -->",
    "title: Dedup the date helpers in src/web",
    "Spotted two copies of formatRelative while working — worth one shared util.",
  ].join("\n");
  expect(parseFollowupComment(body)).toEqual({
    title: "Dedup the date helpers in src/web",
    body: "Spotted two copies of formatRelative while working — worth one shared util.",
  });
});

test("parseFollowupComment falls back to the first line as title when there's no title: key", () => {
  const body = [
    "<!-- pm:followup -->",
    "Add a retry to the dispatch PTY parse",
    "It's flaky.",
  ].join("\n");
  expect(parseFollowupComment(body)).toEqual({
    title: "Add a retry to the dispatch PTY parse",
    body: "It's flaky.",
  });
});

test("parseFollowupComment tolerates markdown noise and an explicit body: label", () => {
  const body = [
    "<!-- pm:followup -->",
    "- **title:** Cache the repo slug lookup",
    "body: It re-shells out every tick.",
  ].join("\n");
  expect(parseFollowupComment(body)).toEqual({
    title: "Cache the repo slug lookup",
    body: "It re-shells out every tick.",
  });
});

test("parseFollowupComment returns null without the marker, or with nothing usable", () => {
  expect(parseFollowupComment("just a normal comment\ntitle: nope")).toBeNull();
  expect(parseFollowupComment("<!-- pm:followup -->\n   \n")).toBeNull();
});

test("a new follow-up comment changes the sig so it emits pr.updated (→ gets ingested)", () => {
  const prev = index([pr({ number: 1, taskId: 10 })]);
  const next = [
    pr({
      number: 1,
      taskId: 10,
      followups: [{ commentId: 555, title: "do a thing", body: "", updatedAt: "t1" }],
    }),
  ];
  expect(diffCloudPrs(prev, next).map((e) => e.type)).toEqual(["pr.updated"]);
});

test("a fresh status comment (agent.updatedAt bump) emits pr.updated so it persists", () => {
  const base = { number: 1, taskId: 10 };
  const prev = index([
    pr({
      ...base,
      agent: {
        state: "working",
        summary: "a",
        next: null,
        sessionUrl: null,
        body: "x",
        updatedAt: "t1",
      },
    }),
  ]);
  const next = [
    pr({
      ...base,
      agent: {
        state: "blocked",
        summary: "b",
        next: null,
        sessionUrl: null,
        body: "y",
        updatedAt: "t2",
      },
    }),
  ];
  expect(diffCloudPrs(prev, next).map((e) => e.type)).toEqual(["pr.updated"]);
});

test("rebaseAction: a fresh live CONFLICTING asks, a repeat skips (no re-spam)", () => {
  expect(rebaseAction("CONFLICTING", false, false)).toBe("ask");
  expect(rebaseAction("CONFLICTING", true, false)).toBe("skip");
});

test("rebaseAction: going MERGEABLE clears the episode so a later conflict re-asks", () => {
  expect(rebaseAction("MERGEABLE", true, false)).toBe("clear");
  expect(rebaseAction("MERGEABLE", false, false)).toBe("clear");
});

test("rebaseAction: an `initial` (catch-up) CONFLICTING never asks — no boot flood/re-spam", () => {
  expect(rebaseAction("CONFLICTING", false, true)).toBe("skip");
  expect(rebaseAction("CONFLICTING", true, true)).toBe("skip");
});

// The regression durable persistence could introduce: a conflict resolved while we
// were down must still clear the ledger on the boot catch-up, or a stale "asked"
// flag would suppress the *next* real conflict. Clearing must beat the initial skip.
test("rebaseAction: MERGEABLE clears even on an `initial` event (no stale flag after restart)", () => {
  expect(rebaseAction("MERGEABLE", true, true)).toBe("clear");
});

test("rebaseAction: UNKNOWN/null is transient — never asks, never clears", () => {
  expect(rebaseAction("UNKNOWN", false, false)).toBe("skip");
  expect(rebaseAction("UNKNOWN", true, true)).toBe("skip");
  expect(rebaseAction(null, false, false)).toBe("skip");
  expect(rebaseAction(null, true, true)).toBe("skip");
});

test("only the changed PR among many emits", () => {
  const prev = index([
    pr({ number: 1, taskId: 10 }),
    pr({ number: 2, taskId: 20 }),
    pr({ number: 3, taskId: 30, state: "MERGED", merged: true }),
  ]);
  const next = [
    pr({ number: 1, taskId: 10 }), // unchanged
    pr({ number: 2, taskId: 20, merged: true, state: "MERGED" }), // merged now
    pr({ number: 3, taskId: 30, state: "MERGED", merged: true }), // unchanged
  ];
  const evs = diffCloudPrs(prev, next);
  expect(evs).toEqual([{ type: "pr.merged", pr: next[1] }]);
});
