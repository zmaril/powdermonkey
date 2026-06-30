import { Group, List, Text, ThemeIcon, Tooltip, UnstyledButton } from "@mantine/core";
import type { Phase } from "../../server/schema.ts";
import { DecisionSource, PhaseStatus } from "../../shared/types.ts";
import { useStore } from "../store.ts";
import { EditableText } from "./EditableText.tsx";

// A phase's completion, kept visually distinct by who made the call: reconciled is a
// solid green ✓; an operator-asserted one an orange ✋ ("by hand"); a supervisor one
// a violet 🤖. Todo is a gray dot. See docs/completion-model.md.
function phaseGlyph(p: Phase): { color: string; mark: string; title: string } {
  if (p.status !== PhaseStatus.Done) return { color: "gray", mark: "·", title: PhaseStatus.Todo };
  if (p.decisionSource === DecisionSource.Operator)
    return { color: "orange", mark: "✋", title: "marked done by hand — not reconciled from main" };
  if (p.decisionSource === DecisionSource.Supervisor)
    return {
      color: "violet",
      mark: "🤖",
      title: "marked done via the supervisor — not reconciled",
    };
  return { color: "green", mark: "✓", title: "reconciled from a trailer on main" };
}

/** The plan's phase checklist. When `interactive`, each row carries the override
 *  controls (the non-reconciled path): mark a todo phase done by hand, or reopen one
 *  an override completed. Reconciled phases are locked — they reflect `main`, so
 *  they're undone by changing `main`, not a button. */
export function PhaseList({
  phases,
  interactive = false,
  struck = false,
  onRename,
}: {
  phases: Phase[];
  interactive?: boolean;
  struck?: boolean;
  /** When set, each phase name becomes click-to-edit (inline plan editing). */
  onRename?: (phaseId: number, name: string) => void;
}) {
  const { completePhase, reopenPhase } = useStore();
  return (
    <List spacing={2} size="sm" center>
      {phases.map((p) => {
        const g = phaseGlyph(p);
        const done = p.status === PhaseStatus.Done;
        // An override (operator/supervisor) completion can be reopened; a reconciled
        // one is locked.
        const overrideDone = done && p.decisionSource !== DecisionSource.Reconciled;
        return (
          <List.Item
            key={p.id}
            icon={
              <Tooltip label={g.title} withArrow openDelay={300}>
                <ThemeIcon color={g.color} size={16} radius="xl">
                  <Text size="9px">{g.mark}</Text>
                </ThemeIcon>
              </Tooltip>
            }
          >
            <Group gap={6} wrap="nowrap" align="baseline" style={{ flex: 1, minWidth: 0 }}>
              {onRename ? (
                <EditableText
                  value={p.name}
                  size="sm"
                  wrap
                  dimmed={done || struck}
                  strikethrough={done || struck}
                  onSave={(v) => onRename(p.id, v)}
                />
              ) : (
                <Text
                  size="sm"
                  style={{ wordBreak: "break-word" }}
                  c={done || struck ? "dimmed" : undefined}
                  td={done || struck ? "line-through" : undefined}
                >
                  {p.name}
                </Text>
              )}
              {interactive && !done && (
                <UnstyledButton
                  onClick={() => completePhase(p.id)}
                  title="Mark this phase done by hand"
                >
                  <Text size="xs" c="blue.4">
                    done
                  </Text>
                </UnstyledButton>
              )}
              {interactive && overrideDone && (
                <UnstyledButton
                  onClick={() => reopenPhase(p.id)}
                  title="Reopen — this was marked done by hand"
                >
                  <Text size="xs" c="dimmed">
                    reopen
                  </Text>
                </UnstyledButton>
              )}
            </Group>
          </List.Item>
        );
      })}
    </List>
  );
}
