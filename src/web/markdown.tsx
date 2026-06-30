import DOMPurify from "dompurify";
import { marked } from "marked";
import { useMemo } from "react";

// Shared markdown renderer — GitHub-flavoured, sanitized (PR descriptions, review
// comments and agent comments all come from contributors, so the output is run
// through DOMPurify before it touches the DOM). Used by the review pane and the
// Active pane's agent-comment column.

// Styles for rendered markdown, injected once. Scoped to `.pm-md`. Colors read off
// the active theme's `--pm-*` tokens (themes.ts) so the markdown re-skins — and stays
// readable under the light themes — along with everything else.
let mdStylesInjected = false;
function ensureMdStyles() {
  if (mdStylesInjected || typeof document === "undefined") return;
  mdStylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
.pm-md{color:var(--pm-text);font-size:0.8125rem;line-height:1.55;word-break:break-word;}
.pm-md>*:first-child{margin-top:0;}
.pm-md h1,.pm-md h2,.pm-md h3,.pm-md h4{color:var(--pm-text);margin:14px 0 6px;line-height:1.3;}
.pm-md h1{font-size:1.125rem;} .pm-md h2{font-size:1rem;} .pm-md h3{font-size:0.875rem;} .pm-md h4{font-size:0.8125rem;}
.pm-md p{margin:6px 0;} .pm-md a{color:var(--pm-accent);}
.pm-md code{background:var(--pm-surface);padding:1px 4px;border-radius:3px;font-family:var(--mantine-font-family-monospace);font-size:0.75rem;}
.pm-md pre{background:var(--pm-page-bg);border:1px solid var(--pm-hairline);border-radius:6px;padding:10px;overflow:auto;}
.pm-md pre code{background:none;padding:0;}
.pm-md ul,.pm-md ol{margin:6px 0;padding-left:20px;} .pm-md li{margin:2px 0;}
.pm-md blockquote{border-left:3px solid var(--pm-hairline);margin:6px 0;padding:2px 10px;color:var(--pm-dim-text);}
.pm-md table{border-collapse:collapse;margin:6px 0;} .pm-md th,.pm-md td{border:1px solid var(--pm-hairline);padding:4px 8px;}
.pm-md img{max-width:100%;} .pm-md hr{border:none;border-top:1px solid var(--pm-hairline);margin:12px 0;}
.pm-md-inline,.pm-md-inline p{display:inline;margin:0;font-size:inherit;}
`;
  document.head.appendChild(style);
}

/** Render GitHub-flavoured markdown, sanitized. `inline` skips the block wrapper
 *  (for a one-line title). */
export function Markdown({ source, inline }: { source: string; inline?: boolean }) {
  ensureMdStyles();
  const html = useMemo(() => {
    const raw = inline ? marked.parseInline(source) : marked.parse(source);
    return DOMPurify.sanitize(typeof raw === "string" ? raw : "");
  }, [source, inline]);
  return (
    <div
      className={inline ? "pm-md pm-md-inline" : "pm-md"}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: output is sanitized by DOMPurify above.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
