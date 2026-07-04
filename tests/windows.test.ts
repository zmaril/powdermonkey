import { expect, test } from "bun:test";
import type { SerializedDockview } from "dockview-react";
import {
  type PmWindow,
  closeWindow,
  fromLegacyLayout,
  newWindow,
  resolveActive,
  updateWindow,
  windowLabel,
} from "../src/web/windows.ts";

// The pure Window core (windows.ts): construction, list surgery, the legacy
// single-layout migration, and labeling. These pin the semantics the store
// delegates to — a device's window list is never empty, closing the active
// window hands focus to a neighbour, and a v0 layout folds into "window 1".

const layout = { grid: {}, panels: {} } as unknown as SerializedDockview;

test("newWindow: unscoped, unnamed, no layout yet", () => {
  const w = newWindow();
  expect(w.repoIds).toEqual([]);
  expect(w.name).toBeNull();
  expect(w.layout).toBeNull();
  expect(w.scratch).toBe("");
  expect(w.id).not.toBe(newWindow().id); // ids are minted per window
});

test("updateWindow patches one window immutably and ignores unknown ids", () => {
  const a = newWindow([1]);
  const b = newWindow([2]);
  const out = updateWindow([a, b], b.id, { name: "seo push", repoIds: [2, 3] });
  expect(out[0]).toBe(a); // untouched rows keep identity
  expect(out[1].name).toBe("seo push");
  expect(out[1].repoIds).toEqual([2, 3]);
  expect(b.name).toBeNull(); // input not mutated
  expect(updateWindow([a, b], "nope", { name: "x" })).toEqual([a, b]);
});

test("closeWindow: closing a background window keeps the active one", () => {
  const [a, b, c] = [newWindow(), newWindow(), newWindow()];
  const out = closeWindow([a, b, c], b.id, c.id);
  expect(out.windows.map((w) => w.id)).toEqual([a.id, c.id]);
  expect(out.activeId).toBe(c.id);
});

test("closeWindow: closing the active window focuses its right-hand neighbour", () => {
  const [a, b, c] = [newWindow(), newWindow(), newWindow()];
  expect(closeWindow([a, b, c], b.id, b.id).activeId).toBe(c.id);
  // ...and the last window falls back left.
  expect(closeWindow([a, b, c], c.id, c.id).activeId).toBe(b.id);
});

test("closeWindow: the list is never left empty", () => {
  const only = newWindow([7]);
  const out = closeWindow([only], only.id, only.id);
  expect(out.windows).toHaveLength(1);
  expect(out.windows[0].id).not.toBe(only.id); // a fresh window, not the old one
  expect(out.windows[0].repoIds).toEqual([]);
  expect(out.activeId).toBe(out.windows[0].id);
});

test("closeWindow: unknown id is a no-op", () => {
  const a = newWindow();
  const out = closeWindow([a], "nope", a.id);
  expect(out.windows).toEqual([a]);
  expect(out.activeId).toBe(a.id);
});

test("resolveActive falls back to the first window on a stale id", () => {
  const [a, b] = [newWindow(), newWindow()];
  expect(resolveActive([a, b], b.id)).toBe(b);
  expect(resolveActive([a, b], "stale")).toBe(a);
  expect(resolveActive([], "stale")).toBeNull();
});

test("fromLegacyLayout folds a v0 dock layout into window 1", () => {
  const w = fromLegacyLayout(layout);
  expect(w.layout).toBe(layout);
  expect(w.repoIds).toEqual([]);
  expect(fromLegacyLayout(null).layout).toBeNull();
});

test("windowLabel: name, else the repo tabs, else a placeholder", () => {
  const names = new Map([
    [1, "zmaril/powdermonkey"],
    [2, "zmaril/straitjacket"],
  ]);
  const label = (id: number) => names.get(id);
  const w: PmWindow = { ...newWindow([1, 2]), name: null };
  expect(windowLabel(w, label)).toBe("zmaril/powdermonkey · zmaril/straitjacket");
  expect(windowLabel({ ...w, name: "tooling" }, label)).toBe("tooling");
  // An archived/unknown repo drops out of the label rather than rendering a hole.
  expect(windowLabel({ ...w, repoIds: [1, 99] }, label)).toBe("zmaril/powdermonkey");
  expect(windowLabel(newWindow(), label)).toBe("new window");
});
