import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GhResult } from "../src/server/gh.ts";

process.env.PM_DATA_DIR = join(mkdtempSync(join(tmpdir(), "pm-")), "pg");

const { ready } = await import("../src/server/db.ts");
const { repoRepo } = await import("../src/server/crud.ts");
const { canPush, forkArgs, parseForkSlug, parseRepoView, registerRepo, viewRepoArgs } =
  await import("../src/server/repo-register.ts");

// Fork-first registration: the pure seams (argv/parse/permission) plus the whole
// orchestration against a scratch DB with a scripted gh — no spawning, no network.

beforeAll(() => ready());

const ok = (stdout: string): GhResult => ({ ok: true, stdout, stderr: "" });
const fail = (stderr: string): GhResult => ({ ok: false, stdout: "", stderr });

const view = (slug: string, permission: string | null, branch = "main") =>
  JSON.stringify({
    nameWithOwner: slug,
    defaultBranchRef: { name: branch },
    homepageUrl: "",
    viewerPermission: permission,
  });

/** A scripted gh: routes each argv to a canned result by subcommand. */
function fakeGh(script: {
  view?: Record<string, GhResult>;
  fork?: GhResult;
  login?: string;
  calls?: string[][];
}) {
  return async (args: string[]): Promise<GhResult> => {
    script.calls?.push(args);
    if (args[0] === "repo" && args[1] === "view") {
      return script.view?.[args[2]] ?? fail("view: not scripted");
    }
    if (args[0] === "repo" && args[1] === "fork") return script.fork ?? fail("fork: not scripted");
    if (args[0] === "api" && args[1] === "user") return ok(`${script.login ?? ""}\n`);
    return fail("not scripted");
  };
}

describe("pure seams", () => {
  test("viewRepoArgs asks for the registration fields", () => {
    expect(viewRepoArgs("a/b")).toEqual([
      "repo",
      "view",
      "a/b",
      "--json",
      "nameWithOwner,defaultBranchRef,homepageUrl,viewerPermission",
    ]);
  });

  test("forkArgs never clones", () => {
    expect(forkArgs("a/b")).toEqual(["repo", "fork", "a/b", "--clone=false"]);
  });

  test("canPush admits exactly the push-capable permissions", () => {
    expect(canPush("ADMIN")).toBe(true);
    expect(canPush("MAINTAIN")).toBe(true);
    expect(canPush("WRITE")).toBe(true);
    expect(canPush("TRIAGE")).toBe(false);
    expect(canPush("READ")).toBe(false);
    expect(canPush(null)).toBe(false);
  });

  test("parseRepoView pulls the fields and rejects slugless output", () => {
    expect(parseRepoView(view("a/b", "READ", "trunk"))).toEqual({
      slug: "a/b",
      defaultBranch: "trunk",
      homepageUrl: null,
      viewerPermission: "READ",
    });
    expect(parseRepoView("gh: HTTP 404")).toBeNull();
  });

  test("parseForkSlug reads both fresh-fork and re-fork output", () => {
    expect(parseForkSlug("✓ Created fork zmaril/htop")).toBe("zmaril/htop");
    expect(parseForkSlug("! zmaril/htop already exists")).toBe("zmaril/htop");
    expect(parseForkSlug("something else entirely")).toBeNull();
  });
});

describe("registerRepo", () => {
  test("registers a pushable repo directly, no fork", async () => {
    const calls: string[][] = [];
    const r = await registerRepo(
      "zmaril/mine",
      fakeGh({
        view: { "zmaril/mine": ok(view("zmaril/mine", "ADMIN")) },
        calls,
      }),
    );
    if (!r.ok) throw new Error(r.error);
    expect(r).toMatchObject({ created: true, forked: false });
    expect(r.repo).toMatchObject({
      slug: "zmaril/mine",
      owner: "zmaril",
      name: "mine",
      upstream: null,
    });
    expect(calls.some((c) => c[1] === "fork")).toBe(false);
  });

  test("re-registering the same slug returns the existing row untouched", async () => {
    const r = await registerRepo("zmaril/mine", fakeGh({}));
    if (!r.ok) throw new Error(r.error);
    expect(r.created).toBe(false);
    expect((await repoRepo.list()).filter((x) => x.slug === "zmaril/mine")).toHaveLength(1);
  });

  test("forks a repo the operator can't push to and records upstream", async () => {
    const r = await registerRepo(
      "htop-dev/htop",
      fakeGh({
        view: {
          "htop-dev/htop": ok(view("htop-dev/htop", "READ", "trunk")),
          "zmaril/htop": ok(view("zmaril/htop", "ADMIN", "trunk")),
        },
        fork: { ok: true, stdout: "", stderr: "✓ Created fork zmaril/htop" },
      }),
    );
    if (!r.ok) throw new Error(r.error);
    expect(r).toMatchObject({ created: true, forked: true });
    expect(r.repo).toMatchObject({
      slug: "zmaril/htop",
      upstream: "htop-dev/htop",
      defaultBranch: "trunk",
    });
  });

  test("re-registering the upstream returns the fork instead of forking again", async () => {
    const calls: string[][] = [];
    const r = await registerRepo("htop-dev/htop", fakeGh({ calls }));
    if (!r.ok) throw new Error(r.error);
    expect(r).toMatchObject({ created: false, forked: false });
    expect(r.repo.slug).toBe("zmaril/htop");
    expect(calls).toHaveLength(0);
  });

  test("falls back to <login>/<name> when fork output is unparseable", async () => {
    const r = await registerRepo(
      "curl/curl",
      fakeGh({
        view: { "curl/curl": ok(view("curl/curl", null)) },
        fork: ok(""), // silent success (non-tty)
        login: "zmaril",
      }),
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.repo).toMatchObject({ slug: "zmaril/curl", upstream: "curl/curl" });
    // The fork's own view wasn't scripted — metadata falls back to the upstream's.
    expect(r.repo.defaultBranch).toBe("main");
  });

  test("a failed view maps to ok:false with the gh message", async () => {
    const r = await registerRepo(
      "nope/nope",
      fakeGh({ view: { "nope/nope": fail("gh: HTTP 404") } }),
    );
    expect(r).toEqual({ ok: false, error: "gh: HTTP 404" });
  });

  test("a failed fork maps to ok:false", async () => {
    const r = await registerRepo(
      "big/corp",
      fakeGh({
        view: { "big/corp": ok(view("big/corp", "READ")) },
        fork: fail("gh: forking is disabled"),
      }),
    );
    expect(r).toEqual({ ok: false, error: "gh: forking is disabled" });
  });
});
