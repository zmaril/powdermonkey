import type { Repo } from "../../server/schema.ts";
import { repoSwatch } from "../repo-color.ts";
import { useActiveTheme } from "../store.ts";
import type { PmWindow } from "../windows.ts";

/** A window-rail entry's glyph: up to three overlapping repo-color dots (the same
 *  theme-hashed swatches the repo badges use), or a hollow ring when the window is
 *  unscoped. */
export function RailGlyph({ win, byId }: { win: PmWindow; byId: Map<number, Repo> }) {
  const theme = useActiveTheme();
  const repos = win.repoIds.map((id) => byId.get(id)).filter((r): r is Repo => r != null);
  if (repos.length === 0) {
    return (
      <span
        aria-hidden
        style={{
          width: 12,
          height: 12,
          borderRadius: "50%",
          border: "2px solid var(--pm-dim-text)",
          display: "block",
        }}
      />
    );
  }
  return (
    <span aria-hidden style={{ display: "flex", alignItems: "center" }}>
      {repos.slice(0, 3).map((r, i) => (
        <span
          key={r.id}
          style={{
            width: 11,
            height: 11,
            borderRadius: "50%",
            background: repoSwatch(r, theme),
            border: "1.5px solid var(--pm-tab-strip)",
            marginLeft: i === 0 ? 0 : -4,
          }}
        />
      ))}
    </span>
  );
}
