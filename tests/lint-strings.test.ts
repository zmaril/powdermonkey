import { describe, expect, test } from "bun:test";
import { scanText, stringLiterals } from "../scripts/lint-strings.ts";

// The lexer is the load-bearing part: it must pull string-literal *values* out of
// TS/TSX while NOT mistaking quotes inside comments, templates, or regex literals
// (and JSX tags) for real strings. These lock in the cases that bit us.
describe("stringLiterals", () => {
  test("extracts plain string values with line numbers", () => {
    const literals = stringLiterals('const a = "one";\nconst b = "two";');
    expect(literals).toEqual([
      { value: "one", line: 1 },
      { value: "two", line: 2 },
    ]);
  });

  test("ignores line and block comments", () => {
    const literals = stringLiterals('// "nope"\n/* "also nope" */\nconst x = "yes";');
    expect(literals.map((l) => l.value)).toEqual(["yes"]);
  });

  test("ignores template literals", () => {
    const literals = stringLiterals('const x = `a ${"nested"} b`;\nconst y = "real";');
    expect(literals.map((l) => l.value)).toEqual(["real"]);
  });

  test("skips a regex literal whose body contains a backtick and quotes", () => {
    // The real desync: `.replace(/[*`>]/g, "")` — the backtick inside the regex
    // must not open a template, and the `"` after it is the real (empty) string.
    const literals = stringLiterals('line.replace(/[*`>]/g, "").replace(/x/, "keep");');
    expect(literals.map((l) => l.value)).toEqual(["", "keep"]);
  });

  test("treats `/` after a value as division, not a regex", () => {
    const literals = stringLiterals('const r = a / b;\nconst s = "after";');
    expect(literals.map((l) => l.value)).toEqual(["after"]);
  });

  test("handles JSX closing tags without desyncing (TSX)", () => {
    const tsx = '<Group>\n  <Text>{run("local")}</Text>\n</Group>;\nconst k = "remote";';
    expect(stringLiterals(tsx).map((l) => l.value)).toEqual(["local", "remote"]);
  });
});

describe("scanText", () => {
  const values = new Set(["local", "remote", "stopped"]);

  test("flags a bare enum-value literal", () => {
    const v = scanText('run("local");', "f.ts", values);
    expect(v).toEqual([{ file: "f.ts", line: 1, value: "local" }]);
  });

  test("does not flag a non-enum string", () => {
    expect(scanText('run("hello");', "f.ts", values)).toEqual([]);
  });

  test("respects a same-line lint-allow-string comment", () => {
    const v = scanText(
      'const title = "stopped"; // lint-allow-string: display label',
      "f.ts",
      values,
    );
    expect(v).toEqual([]);
  });
});
