import { expect, test } from "bun:test";
import type { SerializedDockview } from "dockview-react";
import {
  type PmWindow,
  closeWindow,
  fromLegacyLayout,
  mergeExternalWindows,
  newWindow,
  planBoot,
  resolveActive,
  updateWindow,
  windowLabel,
  windowWithId,
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
  expect(w.scratchCursor).toBeNull();
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

test("windowWithId: an empty window under a specific id", () => {
  const w = windowWithId("hash-abc");
  expect(w.id).toBe("hash-abc");
  expect(w.repoIds).toEqual([]);
  expect(w.name).toBeNull();
  expect(w.layout).toBeNull();
  expect(w.scratchCursor).toBeNull();
});

test("planBoot: adopts the first window, spawns the rest", () => {
  const [a, b, c] = [newWindow([1]), newWindow([2]), newWindow([3])];
  const plan = planBoot([a, b, c]);
  expect(plan.minted).toBe(false);
  expect(plan.adopt).toBe(a);
  expect(plan.spawn.map((w) => w.id)).toEqual([b.id, c.id]);
});

test("planBoot: an empty registry mints a fresh unscoped window, nothing to spawn", () => {
  const plan = planBoot([]);
  expect(plan.minted).toBe(true);
  expect(plan.adopt.repoIds).toEqual([]);
  expect(plan.spawn).toEqual([]);
});

test("mergeExternalWindows: keeps our active window, adopts the rest", () => {
  const a = newWindow([1]);
  const b = newWindow([2]);
  const ourA = { ...a, name: "fresh here", scratchCursor: { start: 3, end: 3, scroll: 40 } };
  const staleA = { ...a, name: "stale copy" };
  const theirB = { ...b, name: "their edit" };
  // The other tab edited B and holds a stale A; we're showing A.
  const merged = mergeExternalWindows([ourA, b], [staleA, theirB], a.id);
  expect(merged.find((w) => w.id === a.id)?.name).toBe("fresh here");
  expect(merged.find((w) => w.id === b.id)?.name).toBe("their edit");
});

test("mergeExternalWindows: resurrects our active window if the other tab closed it", () => {
  const a = newWindow();
  const b = newWindow();
  const merged = mergeExternalWindows([a, b], [b], a.id);
  expect(merged.map((w) => w.id)).toEqual([b.id, a.id]);
});

test("mergeExternalWindows: adopts new windows the other tab created", () => {
  const a = newWindow();
  const c = newWindow();
  const merged = mergeExternalWindows([a], [a, c], a.id);
  expect(merged.map((w) => w.id)).toEqual([a.id, c.id]);
  // A stale active id (shouldn't happen, but device state drifts): take theirs wholesale.
  expect(mergeExternalWindows([a], [c], "gone")).toEqual([c]);
});
