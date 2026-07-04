import { expect, test } from "bun:test";
import { formatPmNote, PM_NOTE_VERSION, parsePmNotes } from "../src/server/pm-note.ts";

// The PM-Note payload: one structured JSON trailer per commit replacing the split
// PM-Phase:/PM-Task: trailers + pm:followup comments. These pin the parse/normalize
// contract every reader (reconcile, github-watch) depends on. Pure — no DB.

test("parses a full note off a commit body: phases, task, followups", () => {
  const body = [
    "implement the dispatcher",
    "",
    'PM-Note: {"v":1,"phases":[41,42],"task":40,"followups":[{"title":"dedup helpers","body":"two copies"}]}',
  ].join("\n");
  expect(parsePmNotes(body)).toEqual([
    {
      v: 1,
      phases: [41, 42],
      task: 40,
      followups: [{ title: "dedup helpers", body: "two copies" }],
    },
  ]);
});

test("scans many notes across a concatenated multi-commit log", () => {
  const log = [
    'first\n\nPM-Note: {"v":1,"phases":[1]}',
    'second\n\nPM-Note: {"v":1,"phases":[2,3]}',
    'third\n\nPM-Note: {"v":1,"task":9}',
  ].join("\n\0\n");
  const notes = parsePmNotes(log);
  expect(notes.map((n) => n.phases)).toEqual([[1], [2, 3], []]);
  expect(notes.map((n) => n.task)).toEqual([null, null, 9]);
});

test("defaults absent fields: phases [], task null, followups [], v stamped", () => {
  const [n] = parsePmNotes('PM-Note: {"phases":[7]}');
  expect(n).toEqual({ v: PM_NOTE_VERSION, phases: [7], task: null, followups: [] });
});

test("normalizes phases: single number, dedup, drops non-positive / non-int", () => {
  expect(parsePmNotes('PM-Note: {"phases":5}')[0].phases).toEqual([5]);
  expect(parsePmNotes('PM-Note: {"phases":[3,3,4]}')[0].phases).toEqual([3, 4]);
  expect(parsePmNotes('PM-Note: {"phases":[0,-2,1.5,2]}')[0].phases).toEqual([2]);
});

test("task must be a positive integer, else null", () => {
  expect(parsePmNotes('PM-Note: {"task":40}')[0].task).toBe(40);
  expect(parsePmNotes('PM-Note: {"task":0,"phases":[1]}')[0].task).toBeNull();
});

test("followups tolerate a bare string title and drop title-less entries", () => {
  const [n] = parsePmNotes(
    'PM-Note: {"followups":["just a title",{"title":"  "},{"body":"no title"},{"title":"ok","body":" ctx "}]}',
  );
  expect(n.followups).toEqual([{ title: "just a title" }, { title: "ok", body: "ctx" }]);
});

test("skips malformed JSON, non-object payloads, and empty notes — never throws", () => {
  expect(parsePmNotes("PM-Note: {not json")).toEqual([]);
  expect(parsePmNotes("PM-Note: [1,2,3]")).toEqual([]);
  expect(parsePmNotes('PM-Note: {"v":1}')).toEqual([]); // no signal → dropped
  expect(parsePmNotes("a normal commit\n\nwith no note")).toEqual([]);
});

test("is case-insensitive on the key and tolerates surrounding whitespace", () => {
  expect(parsePmNotes('   pm-note:   {"phases":[8]}  ')[0].phases).toEqual([8]);
});

test("a note with an escaped-newline body stays on one line and round-trips", () => {
  const line = formatPmNote({ followups: [{ title: "t", body: "line one\nline two" }] });
  expect(line.includes("\n")).toBe(false); // single line — survives trailer scanning
  expect(parsePmNotes(line)[0].followups).toEqual([{ title: "t", body: "line one\nline two" }]);
});

test("formatPmNote omits empty fields, always stamps v, and round-trips", () => {
  expect(formatPmNote({ phases: [1, 2] })).toBe('PM-Note: {"v":1,"phases":[1,2]}');
  expect(formatPmNote({ task: 5 })).toBe('PM-Note: {"v":1,"task":5}');
  const line = formatPmNote({ phases: [1], task: 2, followups: [{ title: "x" }] });
  const [back] = parsePmNotes(line);
  expect(back).toEqual({ v: 1, phases: [1], task: 2, followups: [{ title: "x" }] });
});
