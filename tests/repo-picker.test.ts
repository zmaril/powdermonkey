import { describe, expect, test } from "bun:test";
import type { GhResult } from "../src/server/gh.ts";
import {
  listMyRepos,
  listReposArgs,
  parseRepoList,
  parseRepoSearch,
  searchRepos,
  searchReposArgs,
} from "../src/server/repo-picker.ts";

// The picker's gh seam: argv shape and output parsing are the behaviour, so they
// get covered pure (same approach as gh.test.ts — the spawn itself isn't tested).
// The orchestration is exercised through the injectable runner.

const ok = (stdout: string): GhResult => ({ ok: true, stdout, stderr: "" });
const fail = (stderr: string, stdout = ""): GhResult => ({ ok: false, stdout, stderr });

describe("argv builders", () => {
  test("listReposArgs asks for the picker's fields with a limit", () => {
    expect(listReposArgs(50)).toEqual([
      "repo",
      "list",
      "--json",
      "nameWithOwner,description,visibility",
      "--limit",
      "50",
    ]);
  });

  test("searchReposArgs threads the query through", () => {
    expect(searchReposArgs("tmux client", 5)).toEqual([
      "search",
      "repos",
      "tmux client",
      "--json",
      "fullName,description,stargazersCount",
      "--limit",
      "5",
    ]);
  });
});

describe("parseRepoList", () => {
  test("maps gh repo list rows and lowercases visibility", () => {
    const rows = parseRepoList(
      JSON.stringify([
        { nameWithOwner: "z/powdermonkey", description: "boom", visibility: "PUBLIC" },
        { nameWithOwner: "z/secret", description: null, visibility: "PRIVATE" },
      ]),
    );
    expect(rows).toEqual([
      { slug: "z/powdermonkey", description: "boom", visibility: "public", stars: null },
      { slug: "z/secret", description: "", visibility: "private", stars: null },
    ]);
  });

  test("returns [] on non-JSON or non-array output", () => {
    expect(parseRepoList("gh: not logged in")).toEqual([]);
    expect(parseRepoList(JSON.stringify({ message: "rate limited" }))).toEqual([]);
  });

  test("drops rows without a slug", () => {
    expect(parseRepoList(JSON.stringify([{ description: "no name" }]))).toEqual([]);
  });
});

describe("parseRepoSearch", () => {
  test("maps gh search rows with stars, always public", () => {
    const rows = parseRepoSearch(
      JSON.stringify([{ fullName: "a/b", description: "d", stargazersCount: 12 }]),
    );
    expect(rows).toEqual([{ slug: "a/b", description: "d", visibility: "public", stars: 12 }]);
  });
});

describe("listMyRepos", () => {
  test("wraps parsed rows on success", async () => {
    const r = await listMyRepos(async () =>
      ok(JSON.stringify([{ nameWithOwner: "z/a", description: "", visibility: "PUBLIC" }])),
    );
    expect(r).toEqual({
      ok: true,
      repos: [{ slug: "z/a", description: "", visibility: "public", stars: null }],
    });
  });

  test("maps a failed gh to ok:false with the stderr message", async () => {
    const r = await listMyRepos(async () => fail("gh: To get started with GitHub CLI, run gh auth login"));
    expect(r).toEqual({ ok: false, error: "gh: To get started with GitHub CLI, run gh auth login" });
  });
});

describe("searchRepos", () => {
  test("zero matches (gh exits 1 with an empty array) is a valid empty result", async () => {
    const r = await searchRepos("nomatch", async () => fail("no results", "[]"));
    expect(r).toEqual({ ok: true, repos: [] });
  });

  test("a real failure (nothing usable on stdout) maps to ok:false", async () => {
    const r = await searchRepos("q", async () => fail("gh: connection refused"));
    expect(r).toEqual({ ok: false, error: "gh: connection refused" });
  });
});
