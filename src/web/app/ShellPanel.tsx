import type { IDockviewPanelProps } from "dockview-react";
import { useState } from "react";
import { ShellTerminal } from "../ShellTerminal.tsx";
import { SessionEndedOverlay } from "./SessionEndedOverlay.tsx";

export function ShellPanel(props: IDockviewPanelProps<{ cwd: string; session: number | null }>) {
  const [ended, setEnded] = useState(false);
  const session = props.params.session;
  return (
    <div style={{ height: "100%", width: "100%", background: "#1a1b1e", position: "relative" }}>
      <ShellTerminal
        cwd={props.params.cwd || undefined}
        session={session ?? undefined}
        onEnded={() => setEnded(true)}
      />
      {ended && session != null && (
        <SessionEndedOverlay sessionId={session} onClose={() => props.api.close()} />
      )}
    </div>
  );
}
