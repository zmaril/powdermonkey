// Nervo — undo/history.
//
// Because every state change is a `Transaction` that carries its own `before` and
// `after` (bus.ts), history is a plain two-stack undo/redo over those transactions. The
// core doesn't own entity storage, so undo/redo return the transaction and the CALLER
// restores `tx.before` (undo) or re-applies `tx.after` (redo) into wherever its entities
// live. This keeps history domain-agnostic: it reverses *moves*, not database rows.

import type { Transaction } from "./bus.ts";

/** A reversible log of dispatched transactions. Recording a new transaction clears the
 *  redo stack, the usual editor semantics. */
export class History {
  private done: Transaction[] = [];
  private undone: Transaction[] = [];

  /** Append a just-applied transaction, invalidating any redo future. */
  record(tx: Transaction): void {
    this.done.push(tx);
    this.undone = [];
  }

  canUndo(): boolean {
    return this.done.length > 0;
  }

  canRedo(): boolean {
    return this.undone.length > 0;
  }

  /** Pop the last transaction onto the redo stack and return it; the caller restores
   *  `tx.before`. Null when there's nothing to undo. */
  undo(): Transaction | null {
    const tx = this.done.pop();
    if (!tx) return null;
    this.undone.push(tx);
    return tx;
  }

  /** Re-apply the last undone transaction and return it; the caller restores `tx.after`.
   *  Null when there's nothing to redo. */
  redo(): Transaction | null {
    const tx = this.undone.pop();
    if (!tx) return null;
    this.done.push(tx);
    return tx;
  }

  /** The applied transactions, oldest first — the "book of work" for this session. */
  get entries(): readonly Transaction[] {
    return this.done;
  }
}
