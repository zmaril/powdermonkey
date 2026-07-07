import { Button, Card, Group, SegmentedControl, Select, Textarea } from "@mantine/core";
import { useClickOutside } from "@mantine/hooks";
import { useLiveQuery } from "@tanstack/react-db";
import { useState } from "react";
import type { Phase, Task } from "../../../server/schema.ts";
import { TaskKind } from "../../../shared/types.ts";
import { reposCollection } from "../../collections.ts";
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

/** Edit a whole card as one block — title on the first line, phases as "- " bullets,
 *  plus the card's kind (task | bug | spike), free-form description, and repo. Phases
 *  stay pure work steps; the description carries the context. With `task` it edits in
 *  place (reconciling phases by position: renamed, added, or deleted); without one
 *  it's a NEW card seeded from a template and `onCreate` makes it. ⌘/Ctrl+Enter or
 *  clicking away saves an edit; Escape / Cancel discard. */
export function CardEditor({
  task,
  phases = [],
  onCreate,
  onDone,
}: {
  task?: Task;
  phases?: Phase[];
  onCreate?: (
    title: string,
    phaseNames: string[],
    kind: TaskKind,
    description: string | null,
  ) => void;
  onDone: () => void;
}) {
  const { updateTask, createPhase, updatePhase, deletePhase } = useStore();
  const [text, setText] = useState(() => (task ? toText(task, phases) : TEMPLATE));
  const [kind, setKind] = useState<TaskKind>(task?.kind ?? TaskKind.Task);
  const [description, setDescription] = useState(task?.description ?? "");
  const [repoId, setRepoId] = useState<number | null>(task?.repoId ?? null);
  const repos = useLiveQuery(() => reposCollection);
  const repoOptions = (repos.data ?? []).map((r) => ({ value: String(r.id), label: r.name }));

  const save = () => {
    const { title, names } = parse(text, task?.title ?? "");
    if (!title) {
      onDone();
      return;
    }
    const desc = description.trim() || null;
    if (task) {
      const fields: {
        title?: string;
        kind?: TaskKind;
        description?: string | null;
        repoId?: number | null;
      } = {};
      if (title !== task.title) fields.title = title;
      if (kind !== task.kind) fields.kind = kind;
      if (desc !== (task.description ?? null)) fields.description = desc;
      if ((repoId ?? null) !== (task.repoId ?? null)) fields.repoId = repoId;
      if (Object.keys(fields).length > 0) updateTask(task.id, fields);
      phases.forEach((p, i) => {
        if (i < names.length) {
          if (p.name !== names[i]) updatePhase(p.id, { name: names[i] });
        } else {
          deletePhase(p.id);
        }
      });
      for (let i = phases.length; i < names.length; i++) createPhase(task.id, names[i], i);
    } else {
      onCreate?.(title, names, kind, desc);
    }
    onDone();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onDone();
    else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
  };

  // Clicking outside an existing-task edit SAVES (blur-to-commit — losing a typed
  // description or kind to a stray click was the trap). A brand-new card still discards,
  // so a stray click can't materialize a task from the template. Escape / Cancel discard.
  const ref = useClickOutside(() => (task ? save() : onDone()));

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
        onKeyDown={onKeyDown}
        onClick={(e) => e.stopPropagation()}
        description={'First line = title · "- " lines = phases · ⌘/Ctrl+Enter saves, Esc cancels'}
      />
      <Textarea
        value={description}
        autosize
        minRows={1}
        size="sm"
        mt="xs"
        placeholder="Description — context: why, what's known (optional)"
        onChange={(e) => setDescription(e.currentTarget.value)}
        onKeyDown={onKeyDown}
        onClick={(e) => e.stopPropagation()}
      />
      <Group justify="space-between" gap="xs" mt="xs">
        <Group gap="xs" wrap="nowrap">
          <SegmentedControl
            size="xs"
            value={kind}
            onChange={(v) => setKind(v as TaskKind)}
            data={[
              { label: TaskKind.Task, value: TaskKind.Task },
              { label: TaskKind.Bug, value: TaskKind.Bug },
              { label: TaskKind.Spike, value: TaskKind.Spike },
            ]}
          />
          {/* Repo picker — only on an existing task (a new card's repo comes from its
              milestone/goal on create); clearable to unset back to inherited/none. The
              dropdown stays in-card (withinPortal:false) so picking an option isn't read
              as a click-outside → premature save. */}
          {task && repoOptions.length > 0 && (
            <Select
              size="xs"
              clearable
              searchable
              placeholder="repo"
              value={repoId != null ? String(repoId) : null}
              onChange={(v) => setRepoId(v ? Number(v) : null)}
              data={repoOptions}
              comboboxProps={{ withinPortal: false }}
              maxDropdownHeight={200}
              style={{ width: 150 }}
            />
          )}
        </Group>
        <Group gap="xs">
          <Button size="compact-xs" variant="subtle" color="gray" onClick={onDone}>
            Cancel
          </Button>
          <Button size="compact-xs" color="blue" onClick={save}>
            Save
          </Button>
        </Group>
      </Group>
    </Card>
  );
}
