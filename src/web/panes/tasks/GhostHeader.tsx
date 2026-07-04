import { type Ghost, ghostLabel } from "../../ghosts.ts";
import { GhostCard } from "./GhostCard.tsx";

/** A proposed new milestone or goal — a dashed block with its title and the standard
 *  accept/reject strip, matching the ghost task cards. Any child tasks/phases the create
 *  also proposes ride along when it's accepted. */
export function GhostHeader({ ghost }: { ghost: Ghost }) {
  return <GhostCard ghost={ghost} titleWeight={600} label={ghostLabel(ghost)} />;
}
