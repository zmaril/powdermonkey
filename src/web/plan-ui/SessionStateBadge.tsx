import { Badge, Group } from "@mantine/core";
import type { Session } from "../../server/schema.ts";
import { SESSION_BADGE } from "./constants.ts";

/** The live session's state, shown once in a worker card's header: a "needs you"
 *  flag when it's parked for input, plus the running / Try Again / idle / stopped
 *  badge. The state belongs to the worker, not each task, so it lives here. */
export function SessionStateBadge({ session }: { session: Session }) {
  return (
    <Group gap="snug" wrap="nowrap">
      {session.needsInput && (
        <Badge color="yellow" variant="filled">
          needs you
        </Badge>
      )}
      <Badge color={SESSION_BADGE[session.state].color} variant="filled">
        {SESSION_BADGE[session.state].label}
      </Badge>
    </Group>
  );
}
