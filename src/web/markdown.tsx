import DOMPurify from "dompurify";
import { marked } from "marked";
import { useMemo } from "react";

// Shared markdown renderer — GitHub-flavoured, sanitized (PR descriptions, review
// comments and agent comments all come from contributors, so the output is run
// through DOMPurify before it touches the DOM). Used by the review pane and the
// Active pane's agent-comment column.

// Dark-theme styles for rendered markdown, injected once. Scoped to `.pm-md`.
let mdStylesInjected = false;
function ensureMdStyles() {
  if (mdStylesInjected || typeof document === "undefined") return;
  mdStylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
.pm-md{color:#c1c2c5;font-size:13px;line-height:1.55;word-break:break-word;}
.pm-md>*:first-child{margin-top:0;}
.pm-md h1,.pm-md h2,.pm-md h3,.pm-md h4{color:#e9ecef;margin:14px 0 6px;line-height:1.3;}
.pm-md h1{font-size:18px;} .pm-md h2{font-size:16px;} .pm-md h3{font-size:14px;} .pm-md h4{font-size:13px;}
.pm-md p{margin:6px 0;} .pm-md a{color:#4dabf7;}
.pm-md code{background:#2b2d31;padding:1px 4px;border-radius:3px;font-family:ui-monospace,Menlo,monospace;font-size:12px;}
.pm-md pre{background:#16171a;border:1px solid #2c2e33;border-radius:6px;padding:10px;overflow:auto;}
.pm-md pre code{background:none;padding:0;}
.pm-md ul,.pm-md ol{margin:6px 0;padding-left:20px;} .pm-md li{margin:2px 0;}
.pm-md blockquote{border-left:3px solid #3a3d44;margin:6px 0;padding:2px 10px;color:#a6a7ab;}
.pm-md table{border-collapse:collapse;margin:6px 0;} .pm-md th,.pm-md td{border:1px solid #2c2e33;padding:4px 8px;}
.pm-md img{max-width:100%;} .pm-md hr{border:none;border-top:1px solid #2c2e33;margin:12px 0;}
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
