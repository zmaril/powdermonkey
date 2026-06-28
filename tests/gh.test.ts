import { expect, test } from "bun:test";
import { claudeMessage, commentArgs } from "../src/server/gh.ts";

// gh.ts is the write side of the @claude channel. The spawn itself isn't unit-
// tested (it shells out), but the two pure bits — argv shape and the @claude tag —
// are where the behaviour lives, so they get covered here.

test("commentArgs builds `gh pr comment` argv without a repo", () => {
  expect(commentArgs(42, "hello")).toEqual(["pr", "comment", "42", "--body", "hello"]);
});

test("commentArgs threads --repo through when targeting another repo", () => {
  expect(commentArgs(7, "hi", "o/r")).toEqual([
    "pr",
    "comment",
    "7",
    "--repo",
    "o/r",
    "--body",
    "hi",
  ]);
});

test("claudeMessage leads with the @claude tag and trims the instruction", () => {
  expect(claudeMessage("  please rebase  ")).toBe("@claude please rebase");
});
