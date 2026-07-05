// straitjacket-allow-file:duplication  unitIndices intentionally mirrors the server's
// apply.unitIndices while the boundary is being drawn — this is the generic, host-agnostic
// lifting of that algorithm, and the two coexist by design until the deferred migration
// has apply.ts delegate to Nervo (under the boundary lint). See docs/layers.md § Packaging.
//
// Nervo — the proposals model.
//
// A proposal is a pending change-set the operator decides on, one unit at a time. This
// is the domain-agnostic core of what PowderMonkey's server does (proposals.ts /
// apply.ts): the change vocabulary and the create-subtree grouping — the rule that a new
// entity and the new children hanging off it are accepted or rejected *together*, since
// the children's parent only exists if the root does. What the core owns is the shape and
// the grouping; a host owns actually writing an accepted change into its store.
//
// The op vocabulary is Nervo's own (`add`/`edit`/`remove`/`move`), deliberately not
// spelled the same as any one host's — a host maps its own operations onto these.

type ValueOf<T> = T[keyof T];

/** The four kinds of change a proposal carries. */
export const ChangeOp = {
  Add: "add",
  Edit: "edit",
  Remove: "remove",
  Move: "move",
} as const;
export type ChangeOp = ValueOf<typeof ChangeOp>;

/** One typed mutation. `add` may parent to an existing entity (`parentId`) or to a
 *  sibling `add` in the same proposal (`parentRef`), so a whole new subtree proposes at
 *  once; `ref` is the temp handle other adds point at. */
export type Change =
  | {
      op: "add";
      kind: string;
      ref?: string;
      parentRef?: string;
      parentId?: string | number;
      fields: Record<string, unknown>;
    }
  | { op: "edit"; kind: string; id: string | number; fields: Record<string, unknown> }
  | { op: "remove"; kind: string; id: string | number }
  | {
      op: "move";
      kind: string;
      id: string | number;
      parentId?: string | number;
      position?: number;
    };

/** A pending change-set awaiting per-unit decisions. */
export type Proposal = {
  id: string;
  title?: string;
  changes: Change[];
};

/** The change indices that form ONE decidable unit with `start`: the change itself plus
 *  every `add` that chains to it through `parentRef` (its created subtree). A non-`add`
 *  or ref-less change is a singleton. Mirrors PowderMonkey's apply.unitIndices, lifted to
 *  the generic vocabulary. */
export function unitIndices(changes: Change[], start: number): Set<number> {
  const unit = new Set<number>([start]);
  const root = changes[start];
  if (!root || root.op !== ChangeOp.Add || !root.ref) return unit;

  const refs = new Set<string>([root.ref]);
  let grew = true;
  while (grew) {
    grew = false;
    changes.forEach((c, i) => {
      if (unit.has(i)) return;
      if (c.op === ChangeOp.Add && c.parentRef != null && refs.has(c.parentRef)) {
        unit.add(i);
        if (c.ref) refs.add(c.ref);
        grew = true;
      }
    });
  }
  return unit;
}

/** Decide the unit that `index` belongs to. `keep` accepts it (the caller applies the
 *  returned `unit` to its store), otherwise it's dropped. Either way the unit leaves the
 *  proposal; `remaining` is the change-set with it removed — empty means the proposal is
 *  fully decided. Pure: the caller owns applying and persisting. */
export function decide(
  changes: Change[],
  index: number,
  keep: boolean,
): { unit: Change[]; remaining: Change[]; done: boolean } {
  const idx = unitIndices(changes, index);
  const unit = [...idx].sort((a, b) => a - b).map((i) => changes[i]);
  const remaining = changes.filter((_, i) => !idx.has(i));
  return { unit: keep ? unit : [], remaining, done: remaining.length === 0 };
}
