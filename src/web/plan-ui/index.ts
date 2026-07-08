// Shared rendering for the panes (Active / Backlog / Archive): the status/session
// badges, the rolled-up progress bar, the phase checklist, and the per-task action
// buttons — one component per file, re-exported here so callers import from a single
// `./plan-ui` entry. Keeping these in one place means a task looks the same
// whichever pane shows it.

export { AgentNarrative } from "./AgentNarrative.tsx";
export { AgentStateBadge } from "./AgentStateBadge.tsx";
export { CompleteTaskControl } from "./CompleteTaskControl.tsx";
export { KIND_ICON, SESSION_BADGE, STATUS_COLOR, TASK_KIND_COLOR } from "./constants.ts";
export { EditableText } from "./EditableText.tsx";
export { IdTag } from "./IdTag.tsx";
export { KindBadge } from "./KindBadge.tsx";
export { LaunchActions } from "./LaunchActions.tsx";
export { PhaseList } from "./PhaseList.tsx";
export { ProgressBar } from "./ProgressBar.tsx";
export { ProgressPill } from "./ProgressPill.tsx";
export { PrRow } from "./PrRow.tsx";
export { RepoBadge, useRepo, useSessionRepo } from "./RepoBadge.tsx";
export { prNumberFromUrl, ReviewLink } from "./ReviewLink.tsx";
export { SessionActions } from "./SessionActions.tsx";
export { SessionStateBadge } from "./SessionStateBadge.tsx";
export { StarToggle } from "./StarToggle.tsx";
export { TaskBadges } from "./TaskBadges.tsx";
export { TaskLinks } from "./TaskLinks.tsx";
