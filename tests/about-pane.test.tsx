import { describe, expect, test } from "bun:test";
import { AboutPane } from "../src/web/AboutPane.tsx";
import { renderUI, screen } from "./web-render.tsx";

// Example component test: proves the React/Mantine + happy-dom path works end to end
// (mount a real pane, read the rendered DOM). AboutPane is pure presentation, so it's
// the smallest honest smoke test of the setup — no store, no server, no browser.
describe("AboutPane", () => {
  test("renders the product name and the header label", () => {
    renderUI(<AboutPane />);
    expect(screen.getByRole("heading", { name: "PowderMonkey" })).toBeInTheDocument();
    // PaneShell renders the title upper-cased as a dimmed header.
    expect(screen.getByText("ABOUT")).toBeInTheDocument();
  });

  test("links out to the repo, opening in a new tab", () => {
    renderUI(<AboutPane />);
    const link = screen.getByRole("link", { name: /github\.com\/zmaril\/powdermonkey/ });
    expect(link).toHaveAttribute("href", "https://github.com/zmaril/powdermonkey");
    expect(link).toHaveAttribute("target", "_blank");
  });
});
