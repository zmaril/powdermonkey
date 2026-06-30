import { Button, Card, Group, Textarea } from "@mantine/core";
import { useClickOutside } from "@mantine/hooks";
import { useState } from "react";
import type { Phase, Task } from "../../../server/schema.ts";
import { useStore } from "../../store.ts";

const EDIT_BORDER = "1px solid var(--mantine-color-blue-5)";

// The starter a new card opens with, so "+ Add task" gives you a shape to fill in.
const TEMPLATE = "Task title\n- first phase\n- second phase";

/** Serialize a task + its phases to the craft format: title on line 1, each phase a "- "
 *  bullet. */
function toText(task: Task, phases: Phase[]): string {
  return [task.title, ...phases.map((p) => `- ${p.name}`)].join("\n");
}

/** Parse the craft text back into a title (first non-bullet line) and ordered phase names
 *  (the "- " / "* " lines). */
function parse(text: string, fallbackTitle: string): { title: string; names: string[] } {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const title = lines.find((l) => !/^[-*]\s/.test(l)) ?? fallbackTitle;
  const names = lines
    .filter((l) => /^[-*]\s+/.test(l))
    .map((l) => l.replace(/^[-*]\s+/, "").trim());
  return { title, names };
}

/** Edit a whole card as one block — title on the first line, phases as "- " bullets — so
 *  you craft the title and all the phases together. With `task` it edits in place
 *  (reconciling phases by position: renamed, added, or deleted); without one it's a NEW
 *  card seeded from a template and `onCreate(title, names)` makes it. ⌘/Ctrl+Enter saves,
 *  Escape cancels. */
export function CardEditor({
  task,
  phases = [],
  onCreate,
  onDone,
}: {
  task?: Task;
  phases?: Phase[];
  onCreate?: (title: string, phaseNames: string[]) => void;
  onDone: () => void;
}) {
  const { updateTask, createPhase, updatePhase, deletePhase } = useStore();
  const [text, setText] = useState(() => (task ? toText(task, phases) : TEMPLATE));
  // Click anywhere outside the editor cancels (discards), same as Escape.
  const ref = useClickOutside(() => onDone());

  const save = () => {
    const { title, names } = parse(text, task?.title ?? "");
    if (!title) {
      onDone();
      return;
    }
    if (task) {
      if (title !== task.title) updateTask(task.id, { title });
      phases.forEach((p, i) => {
        if (i < names.length) {
          if (p.name !== names[i]) updatePhase(p.id, { name: names[i] });
        } else {
          deletePhase(p.id);
        }
      });
      for (let i = phases.length; i < names.length; i++) createPhase(task.id, names[i], i);
    } else {
      onCreate?.(title, names);
    }
    onDone();
  };

  return (
    <Card ref={ref} withBorder radius="md" padding="sm" style={{ border: EDIT_BORDER }}>
      <Textarea
        value={text}
        autosize
        minRows={3}
        size="sm"
        autoFocus
        spellCheck={false}
        onChange={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onDone();
          else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
        }}
        onClick={(e) => e.stopPropagation()}
        description={'First line = title · "- " lines = phases · ⌘/Ctrl+Enter saves, Esc cancels'}
      />
      <Group justify="flex-end" gap="xs" mt="xs">
        <Button size="compact-xs" variant="subtle" color="gray" onClick={onDone}>
          Cancel
        </Button>
        <Button size="compact-xs" color="blue" onClick={save}>
          Save
        </Button>
      </Group>
    </Card>
  );
}
