# Windows — one real OS window per repo-set

> Status: **superseded design** — this replaces the earlier "Firefox-style lenses
> in a left rail" sketch. A Window is no longer an in-app view you swap to from a
> rail; it is a **real native OS window**. This doc records the model and how it maps
> onto Tauri (desktop) and the browser (fallback). See also
> [vocabulary.md](vocabulary.md) § Window and Decision 4.

A **Window** is a real window on your desktop: one native OS window per PM window,
each owning its own **repo-set** (the repos it shows) and its own **dock layout**
(the dockview split you look at them through). Modeled on Firefox windows — usually
unnamed and disposable, identified by its repo set, reopened on relaunch. Still a
pure frontend concern: not part of the plan hierarchy, not synced across machines.

The shift from the old model: there is **no rail** and **no in-app window switching**.
You don't swap the dock between saved views inside one window; you open a *second real
window* with `Cmd/Ctrl-N` and put it wherever you want it — side by side, on another
monitor, on another Space. Switching windows is your OS's job, exactly like Firefox.

## What owns what

```
 ┌─ native window A ────────┐   ┌─ native window B ────────┐
 │  repo-set: pm · sj       │   │  repo-set: (unscoped)    │
 │  dock: sessions | tasks  │   │  dock: tasks | shell     │
 │  scratch cursor          │   │  scratch cursor          │
 └──────────────────────────┘   └──────────────────────────┘
      one PM window                   one PM window
                    ▲ each is a real OS window ▲
      shared per-origin localStorage: the window *registry* + global chrome
```

Every native window renders **exactly one** PM window. A PM window owns:

- **`repoIds`** — its repo "tabs"; the panes show the *union* of these repos. `[]` =
  unscoped (everything). This is the window's scope, persisted with the window.
- **`layout`** — the dockview arrangement (`api.toJSON()`), persisted per window.
- **`name`** — optional; an unnamed window reads as its repo set.
- **`scratchCursor`** — where this window last was in the (global, server-side)
  Scratch note. The content is global; the window only remembers its cursor.

The **global chrome** (agents-running count, Claude usage) is supervisor-wide and
renders identically in every window — it tracks the shared cap, not any one window.

## Identity & persistence

Each webview knows which PM window it is from its URL hash: **`#w=<id>`**. That is the
per-window identity, stable across reloads (including the disconnect→reload recovery,
which reloads the same webview with the same hash).

All windows on one origin (every native Tauri window, every browser tab) share one
`localStorage` blob (`pm-ui`, the zustand `persist` store). It holds the **registry** —
the list of open PM windows and each one's `repoIds` / `layout` / `name` /
`scratchCursor`:

```ts
type PmWindow = {
  id: string;                          // client-minted; the `#w=<id>` identity
  name: string | null;
  repoIds: number[];                   // [] = unscoped
  layout: SerializedDockview | null;   // null = build the default on first show
  scratchCursor: ScratchCursor | null;
};

// store (shared per origin)
windows: PmWindow[];        // the registry: every currently-open PM window
activeWindowId: string;     // which registry entry THIS webview renders (from #w=)
```

`activeWindowId` is **per-webview**, not shared: it is seeded from the URL hash on
boot and never leaves this webview. It is deliberately **not** persisted — persisting
it would make every webview rehydrate some other webview's id. Only `windows` (the
registry) is shared and persisted.

Because the registry is shared, a write from window B (it created window C, or edited
its own layout) would otherwise clobber window A's copy on the next A write. The rule
is **each webview is authoritative for its own window, and adopts the rest of the
registry** (`mergeExternalWindows`): on a cross-tab `storage` event A keeps its own
window's state and takes B's for everything else — and resurrects its own window if B
somehow dropped it. So A's writes never drop C, and B's writes never stomp A.

## Opening a window — `Cmd/Ctrl-N` (+ a visible affordance)

New windows always open **unscoped**; you scope them afterward from the repo tab strip.

- **Desktop (Tauri).** `Cmd/Ctrl-N` — and the **New window** button in the top bar —
  mint a fresh PM window id, add it to the registry, then spawn a **real native
  window** (`WebviewWindow`, Tauri v2 multi-webview) whose URL carries `#w=<newid>`.
  The new webview boots, reads its hash, and renders its own (empty) window. The
  capability for creating and closing webview windows is granted in
  `src-tauri/capabilities/default.json`.
- **Browser (fallback).** The same button / shortcut `window.open`s a new browser
  window at `#w=<newid>` — a separate OS window carrying the scope in its URL. (Cmd-N
  itself is reserved by browsers, so the button is the reliable affordance there; the
  keyboard shortcut is a desktop feature.)

Either way the opener writes the new window into the shared registry *before* opening,
so the new webview finds itself there.

## Scoping a window — the repo tab strip

Under the top bar, above the dock, sits the window's **repo tab strip**: one chip per
repo in the window's set, plus a `+` to add one. The panes show the **union** of these
repos — remove a chip and its tasks/sessions leave *this* window's view; add one and
they stream in. An empty strip reads "All repos": the window is unscoped. The scope is
this window's alone — persisted with the window, never a shared switcher.

The scope layers **under** each pane's FilterBar: the Sessions/Tasks panes only ever
see plan rows whose repo is in the window's set, and the FilterBar refines within that
(`taskInScope` / `sessionInScope` in `panes/filters.ts`). Nothing is repo-less by
policy (the boot seed backfills), so a scoped window partitions the plan cleanly.

## Lifecycle — `Cmd/Ctrl-W`, and reopen on relaunch

- **Close (`Cmd/Ctrl-W`).** Closing a window removes it from the registry and closes
  the native window (Tauri) / the tab (browser). Firefox-style: a closed window is
  gone, its layout and scope disposed with it. Closing the last window quits the app
  (Tauri) or closes the tab (browser) — there is no synthetic "always one window"
  anymore; a fresh one is minted at the next launch if the registry is empty.
- **Reopen on relaunch (desktop).** Tauri launches one window from `tauri.conf.json`
  (no `#w=` hash — the *primary* boot webview). It reads the registry and:
  - if the registry is non-empty, **adopts the first** entry as its own window and
    **spawns a native window for each remaining** entry (each with its `#w=<id>`), so
    the whole set you had open comes back — layouts, repo sets, and all;
  - if the registry is empty, mints one fresh unscoped window.

  Only the hash-less primary webview fans out; a webview booted *with* a hash (from
  `Cmd-N`, or from the fan-out) just shows its own window and never re-spawns. The
  reconnect→reload path always carries a hash, so it restores one window, not the set.
- **Reopen on relaunch (browser).** The browser restores its own windows/tabs, each
  with its `#w=<id>`; our registry supplies each one's state. We don't `window.open`
  the set on load (popup blockers), so browser session-restore is the browser's tab
  restore plus our per-window persistence.

## Scratch stays global; a window keeps only its cursor

The Scratch pad is one durable, server-side note (the `@notes` the supervisor reads),
shown in every window — closing a window can never lose notes. What is per-window is
the **cursor**: each window remembers its own selection + scroll into the shared pad
and restores it on load.

## Where it lives in the code

- **`windows.ts`** — the pure core: `PmWindow`, `newWindow`, `updateWindow`,
  `removeWindow`, `resolveActive`, `mergeExternalWindows`, `windowLabel`, and the boot
  planner (`planBoot`) that decides what the primary webview adopts and spawns. Free
  of React and the store, so the semantics are unit-tested (`tests/windows.test.ts`).
- **`window-bridge.ts`** — the thin platform layer: `isDesktop()`, spawning a native
  window, closing the current one, and the `Cmd-N` / `Cmd-W` keydown handler.
  Dynamically imports `@tauri-apps/api` only on desktop so the browser bundle never
  touches it.
- **`store.ts`** — holds the registry + this webview's `activeWindowId`; the window
  actions (`createWindow` / `removeWindow` / `renameWindow` / `setWindowRepos` /
  `setLayout` / `setScratchCursor`). `activeWindowId` is dropped from `partialize`.
- **`app/App.tsx`** — boots this webview onto its window (hash → `activeWindowId`),
  restores its layout, mirrors dock changes back via `setLayout`, and keeps the
  registry merged across tabs (`useCrossTabWindows`).
- **`app/WindowTabs.tsx`** / **`app/RepoTab.tsx`** / **`app/WindowName.tsx`** — the
  per-window chrome (repo strip + optional name). There is no `WindowRail`.
- **`src-tauri/`** — `capabilities/default.json` grants webview create/close;
  `tauri.conf.json` still defines the single boot window.
