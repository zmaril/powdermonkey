// Multi-select wiring threaded down to each card: whether a task is checked, a
// toggle, and whether ANY selection is live (so cards can hide their own actions).
export type Selection = { selected: Set<number>; toggle: (id: number) => void; active: boolean };

export type View = "flat" | "grouped";
