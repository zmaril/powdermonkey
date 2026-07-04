import { beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PM_DATA_DIR = join(mkdtempSync(join(tmpdir(), "pm-")), "pg");
process.env.PM_REPOS_DIR = mkdtempSync(join(tmpdir(), "pm-repos-"));

const { ready } = await import("../src/server/db.ts");
const { repoRepo } = await import("../src/server/crud.ts");
const {
  iconCachePath,
  iconCandidates,
  sniffImageType,
  resolveRepoIcon,
  repoIconResponse,
  resetIconResolverState,
} = await import("../src/server/repo-icon.ts");
import type { Repo } from "../src/server/schema.ts";

// A tiny but real PNG header + payload — sniffs as image/png.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
// An ICO header — what most /favicon.ico files actually are.
const ICO = new Uint8Array([0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 9, 9]);
const HTML = new TextEncoder().encode("<!doctype html><title>404</title>");

/** A fake fetcher serving a canned byte body per URL; anything else 404s. Records
 *  the URLs asked for, so tests can pin candidate order and short-circuits. */
function fakeFetch(routes: Record<string, Uint8Array<ArrayBuffer>>) {
  const asked: string[] = [];
  const impl = async (url: string): Promise<Response> => {
    asked.push(url);
    const body = routes[url];
    if (!body) return new Response("nope", { status: 404 });
    return new Response(body);
  };
  return { impl, asked };
}

const AVATAR = "https://github.com/octo.png?size=128";

let nextRepo = 0;
/** A fresh repo row per test — the resolver memoizes per repo id. */
async function makeRepo(homepageUrl: string | null): Promise<Repo> {
  nextRepo++;
  return repoRepo.create({
    slug: `octo/proj${nextRepo}`,
    owner: "octo",
    name: `proj${nextRepo}`,
    homepageUrl,
  });
}

beforeAll(async () => {
  await ready();
});

beforeEach(() => resetIconResolverState());

test("sniffImageType recognizes the favicon/avatar formats and rejects HTML", () => {
  expect(sniffImageType(PNG)).toBe("image/png");
  expect(sniffImageType(ICO)).toBe("image/x-icon");
  expect(sniffImageType(new TextEncoder().encode('<svg xmlns="x"/>'))).toBe("image/svg+xml");
  expect(sniffImageType(HTML)).toBeNull(); // an error page mislabeled as an image
  expect(sniffImageType(new Uint8Array())).toBeNull();
});

test("iconCandidates: homepage favicon first, owner avatar always last", () => {
  expect(iconCandidates({ owner: "octo", homepageUrl: "https://example.com/docs" })).toEqual([
    "https://example.com/favicon.ico",
    AVATAR,
  ]);
  // No homepage (or a malformed one) → avatar only.
  expect(iconCandidates({ owner: "octo", homepageUrl: null })).toEqual([AVATAR]);
  expect(iconCandidates({ owner: "octo", homepageUrl: "not a url" })).toEqual([AVATAR]);
});

test("resolves the homepage favicon, caches it, and persists icon_path", async () => {
  const repo = await makeRepo("https://example.com");
  const { impl } = fakeFetch({ "https://example.com/favicon.ico": ICO });

  const path = await resolveRepoIcon(repo, impl);
  expect(path).toBe(iconCachePath(repo.slug));
  expect(existsSync(path as string)).toBe(true);
  expect((await repoRepo.get(repo.id))?.iconPath).toBe(path);
});

test("falls back to the owner avatar when the favicon is missing or not an image", async () => {
  // Favicon 404s → avatar.
  const a = await makeRepo("https://example.com");
  const fa = fakeFetch({ [AVATAR]: PNG });
  expect(await resolveRepoIcon(a, fa.impl)).toBe(iconCachePath(a.slug));
  expect(fa.asked).toEqual(["https://example.com/favicon.ico", AVATAR]);

  // Favicon serves an HTML error page → rejected by the sniff → avatar.
  const b = await makeRepo("https://example.com");
  const fb = fakeFetch({ "https://example.com/favicon.ico": HTML, [AVATAR]: PNG });
  expect(await resolveRepoIcon(b, fb.impl)).toBe(iconCachePath(b.slug));
});

test("nothing resolvable → null, row untouched, and the failure is memoized", async () => {
  const repo = await makeRepo(null);
  const f = fakeFetch({});
  expect(await resolveRepoIcon(repo, f.impl)).toBeNull();
  expect((await repoRepo.get(repo.id))?.iconPath).toBeNull();
  // The memo swallows the immediate retry — no second network attempt.
  expect(await resolveRepoIcon(repo, f.impl)).toBeNull();
  expect(f.asked).toEqual([AVATAR]);
});

test("repoIconResponse serves the cached bytes with the sniffed content type", async () => {
  const repo = await makeRepo(null);
  const f = fakeFetch({ [AVATAR]: PNG });

  const res = await repoIconResponse(repo.id, f.impl);
  expect(res).not.toBeNull();
  expect(res?.headers.get("content-type")).toBe("image/png");
  expect(new Uint8Array(await (res as Response).arrayBuffer())).toEqual(PNG);

  // Second ask serves straight from disk — no more network.
  await repoIconResponse(repo.id, f.impl);
  expect(f.asked).toEqual([AVATAR]);
});

test("repoIconResponse is null for unknown repos and unresolvable icons", async () => {
  expect(await repoIconResponse(999999)).toBeNull();
  const repo = await makeRepo(null);
  expect(await repoIconResponse(repo.id, fakeFetch({}).impl)).toBeNull();
});
