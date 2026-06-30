import { useState } from "react";
import type { Decision } from "../../../shared/types.ts";
import { useStore } from "../../store.ts";

/** The shared accept/reject driver for inline proposal review: one busy flag, one
 *  conflict message (rare now that accept auto-replans against the current plan), and a
 *  decide() that applies or drops a change. Used wherever a "Proposed: …" strip appears —
 *  task cards, milestone/goal headers, ghost nodes, flat rows. */
export function useDecide() {
  const { decideChange } = useStore();
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);
  const decide = async (proposalId: number, changeIndex: number, decision: Decision) => {
    if (busy) return;
    setBusy(true);
    setConflict(null);
    try {
      const res = await decideChange(proposalId, changeIndex, decision);
      if (!res.ok) setConflict(res.error ?? "could not apply");
    } finally {
      setBusy(false);
    }
  };
  return { busy, conflict, decide };
}
