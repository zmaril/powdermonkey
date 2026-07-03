# Windows — Firefox-style lenses + session restore (design sketch)

> Status: **draft under discussion** — this is the implementation sketch for the
> Windows feature specified in [vocabulary.md](vocabulary.md) § Window (and
> Decisions 4 & 7 there). The open questions at the bottom are being settled on
> the PR thread before the UI shape is locked in; the sketch will be updated to
> record what was decided.

A **Window** is a saved *view*: a set of repo "tabs" plus the panel arrangement
(dockview layout) you look at them through. Modeled on Firefox windows — usually
unnamed and disposable, identified by its repo set, restored on launch. A pure
frontend concern: not part of the plan hierarchy, not synced across machines.

This feature lands in four phases:

1. **Window state model + persistence (per-device)** — the client-side model and
   its storage.
2. **Repo-filtered plan view** — the active window's repo set scopes the
   Sessions/Tasks panes.
3. **Session restore of windows / tabs / layout** — every open window comes back
   on launch, layout and repo tabs intact.
4. **Per-window local scratchpad** — throwaway notes that live and die with the
   window (the global server-side Scratch stays).

## State model (per-device)

The store grows a window list; everything a window owns rides in one object:

```ts
type PmWindow = {
  id: string;                 // client-minted, stable across reloads
  name: string | null;        // optional; unnamed windows read as their repo set
  repoIds: number[];          // the repo "tabs", ordered; [] = unscoped (everything)
  layout: SerializedDockview | null;  // null = build the default layout on first show
  scratch: string;            // the per-window local scratchpad body
};

// store additions
windows: PmWindow[];
activeWindowId: string;
```

Persistence is the existing zustand `persist` (localStorage, key `pm-ui`) — which
is what "per-device" means here: the browser profile / desktop client owns its own
windows, nothing syncs. The current single `layout` field migrates into
`windows[0]` on first load, so an existing device comes up exactly as it was, now
inside "window 1".

Repo identity in the UI (color swatch + icon) comes from the existing repo
registry — the rail and tab strip render `reposCollection` rows by id. A window
holding a repo id that has since been archived just drops that tab on render.

## What changes where

- **`store.ts`** — the window list + active id + actions (create/close/rename/
  switch/set-repo-tabs/set-scratch); `layout` and `setLayout` become per-window.
- **`App.tsx`** — on window switch: `api.toJSON()` is already mirrored on every
  change; swap `activeWindowId`, `fromJSON` the incoming window's layout (same
  compatibility guard as today's reload path).
- **A window rail** — slim, always-open, left of the dock: one entry per window
  (repo icon stack + optional name), a `+` / `Ctrl+N` to open a new window with a
  repo picker, close/rename in place.
- **`filters.ts` / the panes** — a window scope (the active window's `repoIds`)
  layered *under* the FilterBar: the panes only ever see plan rows whose repo is
  in scope; the FilterBar keeps refining within that.
- **A local-scratch pane** — a dock panel like Scratch, but bound to the active
  window's `scratch` string instead of the server note.

## Open questions (being settled on the PR)

1. **Rail-switching vs. real side-by-side windows.** Is v1 one browser tab that
   switches between windows via the rail, or should a PM window map onto an
   actual browser/OS window (two monitors, two windows)? Proposal: rail-switching,
   but pin each browser tab to a window id via the URL (`#w=<id>`) so opening the
   app in a second OS window naturally shows a different PM window.
2. **Union or focused tab.** Do the panes show the *union* of the window's repos
   (tab strip = the working set's composition), or is exactly one repo tab
   focused at a time, Firefox-literal?
3. **Picker scope for v1.** New-window picker over *registered* repos only; the
   Blender-style gh-sourced picker (yours / public search / fork-first) is its
   own follow-up.
4. **Repo-less rows.** Tasks with `repo_id = null` in a repo-scoped window:
   hidden, or surfaced under a "no repo" tab?
