import { createContext, type MouseEvent, useContext } from "react";
import type { Selection } from "./types.ts";

// Multi-select state (which cards are checked, the toggle, whether any selection is live)
// lives at the TasksPane root and is consumed only by the leaf cards. Passing it through
// context keeps the goal / milestone / sortable layers in between from threading a prop
// they never use themselves.
const SelectionContext = createContext<Selection | null>(null);

export const SelectionProvider = SelectionContext.Provider;

export function useSelection(): Selection {
  const selection = useContext(SelectionContext);
  if (!selection) {
    throw new Error("useSelection must be used within a SelectionProvider");
  }
  return selection;
}

/** Shift-click to toggle a card into the multi-selection, without starting a text
 *  selection — the same interaction on the card and the row, so it lives here. Spread
 *  onto the card/row's root element. */
export function shiftSelectHandlers(selection: Selection, id: number) {
  return {
    onMouseDown: (e: MouseEvent) => {
      if (e.shiftKey) e.preventDefault();
    },
    onClick: (e: MouseEvent) => {
      if (e.shiftKey) {
        e.preventDefault();
        selection.toggle(id);
      }
    },
  };
}
