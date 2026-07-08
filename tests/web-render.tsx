import { MantineProvider } from "@mantine/core";
import { type RenderOptions, render } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { buildTheme } from "../src/web/theme.ts";
import { DEFAULT_THEME, getTheme } from "../src/web/themes.ts";

// A `render` that wraps the tree in the same MantineProvider main.tsx uses, so Mantine
// components have their theme context in tests (without it they throw). Mirrors the
// real provider: the default editor palette, its light/dark scheme, density factor 1.
// CSS isn't applied under happy-dom, so this is enough for structure/behaviour tests —
// it is not measuring layout.
const editor = getTheme(DEFAULT_THEME);
const theme = buildTheme(editor, 1);

function Providers({ children }: { children: ReactNode }) {
  return (
    <MantineProvider forceColorScheme={editor.scheme} theme={theme}>
      {children}
    </MantineProvider>
  );
}

export function renderUI(ui: ReactElement, options?: Omit<RenderOptions, "wrapper">) {
  return render(ui, { wrapper: Providers, ...options });
}

// Re-export the rest of Testing Library so tests import everything from one place.
export * from "@testing-library/react";
