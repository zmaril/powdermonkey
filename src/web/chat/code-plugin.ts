// A lean Streamdown code-highlighter plugin: shiki's fine-grained core with a
// curated language set + one theme (github-dark), so the bundle ships ~15
// grammars instead of all ~200. Drop-in replacement for `@streamdown/code`'s
// `code`, matching its CodeHighlighterPlugin contract.

import type { CodeHighlighterPlugin } from "@assistant-ui/react-streamdown";
import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import bash from "shiki/langs/bash.mjs";
import css from "shiki/langs/css.mjs";
import diff from "shiki/langs/diff.mjs";
import go from "shiki/langs/go.mjs";
import html from "shiki/langs/html.mjs";
import javascript from "shiki/langs/javascript.mjs";
import json from "shiki/langs/json.mjs";
import jsx from "shiki/langs/jsx.mjs";
import markdown from "shiki/langs/markdown.mjs";
import python from "shiki/langs/python.mjs";
import rust from "shiki/langs/rust.mjs";
import sql from "shiki/langs/sql.mjs";
import tsx from "shiki/langs/tsx.mjs";
import typescript from "shiki/langs/typescript.mjs";
import yaml from "shiki/langs/yaml.mjs";
import githubDark from "shiki/themes/github-dark.mjs";

const THEME = "github-dark";
const engine = createJavaScriptRegexEngine({ forgiving: true });

// canonical id ← common aliases
const ALIASES: Record<string, string> = {
  ts: "typescript",
  js: "javascript",
  py: "python",
  rs: "rust",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  yml: "yaml",
  md: "markdown",
  plaintext: "text",
  "": "text",
};
const SUPPORTED = new Set([
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "json",
  "bash",
  "python",
  "css",
  "html",
  "markdown",
  "sql",
  "go",
  "rust",
  "yaml",
  "diff",
  "text",
  ...Object.keys(ALIASES),
]);

function canon(lang: string): string {
  const l = lang.trim().toLowerCase();
  return ALIASES[l] ?? l;
}

let hl: HighlighterCore | null = null;
let loading: Promise<HighlighterCore> | null = null;
function ensure(): Promise<HighlighterCore> {
  if (!loading) {
    loading = createHighlighterCore({
      themes: [githubDark],
      langs: [
        typescript,
        tsx,
        javascript,
        jsx,
        json,
        bash,
        python,
        css,
        html,
        markdown,
        sql,
        go,
        rust,
        yaml,
        diff,
      ],
      engine,
    }).then((h) => {
      hl = h;
      return h;
    });
  }
  return loading;
}

function tokenize(h: HighlighterCore, code: string, language: string): any {
  const lang = canon(language);
  const use = h.getLoadedLanguages().includes(lang) ? lang : "text";
  return h.codeToTokens(code, { lang: use, themes: { light: THEME, dark: THEME } });
}

export const code: CodeHighlighterPlugin = {
  name: "shiki",
  type: "code-highlighter",
  supportsLanguage: (l) => SUPPORTED.has(l.trim().toLowerCase()),
  getSupportedLanguages: () => [...SUPPORTED] as any,
  getThemes: () => [THEME, THEME] as any,
  highlight: ({ code: src, language }, cb) => {
    if (hl) return tokenize(hl, src, language);
    ensure()
      .then((h) => cb?.(tokenize(h, src, language)))
      .catch((e) => console.error("[code] highlight failed:", e));
    return null;
  },
};
