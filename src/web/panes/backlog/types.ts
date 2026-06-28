// Multi-select wiring threaded down to each card: whether a task is checked, and a
// toggle. When the selection is non-empty a batch bar appears (see SelectionBar) to
// Start local / Dispatch remote the whole set as ONE session.
export type Selection = { selected: Set<number>; toggle: (id: number) => void };

export type View = "flat" | "grouped";
