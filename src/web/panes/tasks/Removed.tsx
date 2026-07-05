import type { ReactNode } from "react";

/** Removed content in the inline review preview: struck + dimmed, so a delete reads as
 *  "this goes" without vanishing before it's accepted. */
export function Removed({ children }: { children: ReactNode }) {
  return (
    <span style={{ textDecoration: "line-through", color: "var(--mantine-color-dimmed)" }}>
      {children}
    </span>
  );
}
