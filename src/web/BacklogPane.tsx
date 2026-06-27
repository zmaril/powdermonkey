import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import type { Block, PartialBlock } from "@blocknote/core";
import { filterSuggestionItems } from "@blocknote/core/extensions";
import { BlockNoteView } from "@blocknote/mantine";
import {
  type DefaultReactSuggestionItem,
  SuggestionMenuController,
  getDefaultReactSlashMenuItems,
  useCreateBlockNote,
} from "@blocknote/react";
import { Box, Button, Code, CopyButton, Group, Text } from "@mantine/core";
import { useEffect, useRef } from "react";
import type { Task } from "../server/schema.ts";
import { api } from "./client.ts";
import type { Indexes } from "./plan-data.ts";
import { usePlanData } from "./plan-data.ts";
import { useStore } from "./store.ts";

// The Backlog pane is the launchpad — everything to-be-worked (not active),
// grouped goal → milestone. Instead of a wall of forms it's a BlockNote document:
// goals are H1, milestones are H2, and each to-be-worked task is a checklist line
// you can edit like prose. Type a new line and hit "/" to Start local / Dispatch
// remote / Exec now — creating the task and (optionally) launching a session in one
// gesture, after which it leaves the backlog and shows up in the Active pane.
//
// Block ids encode the entity they mirror (`g-12`, `m-3`, `t-57`) so we can map an
// edited line back to a row. Brand-new lines get BlockNote's own random ids; those
// are the ones Save/launch turn into tasks.

const GOAL = (id: number) => `g-${id}`;
const MS = (id: number) => `m-${id}`;
const TASK = (id: number) => `t-${id}`;
const decode = (prefix: string, blockId: string): number | null =>
  blockId.startsWith(prefix) ? Number(blockId.slice(prefix.length)) : null;

/** Plain text of a block's inline content (tasks/headings are plain text). */
function blockText(block: Block): string {
  const c = block.content;
  if (!Array.isArray(c)) return "";
  return c
    .map((n) => ("text" in n && typeof n.text === "string" ? n.text : ""))
    .join("")
    .trim();
}

/** Serialize the plan into BlockNote blocks. Only to-be-worked tasks appear:
 *  active ones live in the Active pane, merged ones are done. */
function planToBlocks(idx: Indexes, activeIds: Set<number>): PartialBlock[] {
  const blocks: PartialBlock[] = [];
  for (const goal of [...idx.goals].sort((a, b) => a.id - b.id)) {
    blocks.push({ id: GOAL(goal.id), type: "heading", props: { level: 1 }, content: goal.title });
    const milestones = idx.milestonesByGoal.get(goal.id) ?? [];
    for (const m of milestones) {
      blocks.push({ id: MS(m.id), type: "heading", props: { level: 2 }, content: m.title });
      const tasks = (idx.tasksByMilestone.get(m.id) ?? []).filter(
        (t) => !activeIds.has(t.id) && t.status !== "merged",
      );
      for (const t of tasks) {
        blocks.push({ id: TASK(t.id), type: "checkListItem", content: t.title });
      }
    }
  }
  return blocks;
}

export function BacklogPane() {
  const { idx, activeIds, loading } = usePlanData();
  const { startLocal, dispatch, refresh, lastStart, dismissStart } = useStore();
  const setError = useStore((s) => s.setError);

  const editor = useCreateBlockNote();

  // Latest plan, so the seed/Reload closures always read current data without
  // re-creating the editor (which would lose the cursor mid-edit).
  const planRef = useRef({ idx, activeIds });
  planRef.current = { idx, activeIds };

  // blockId → taskId for lines that map to a real row; seeded from the plan and
  // extended as new lines get created. Keeps Save/launch from double-creating.
  const taskByBlock = useRef(new Map<string, number>());
  const seeded = useRef(false);

  const seed = () => {
    const { idx: i, activeIds: a } = planRef.current;
    const blocks = planToBlocks(i, a);
    taskByBlock.current = new Map();
    for (const b of blocks) {
      const tid = b.id ? decode("t-", b.id) : null;
      if (tid != null && b.id) taskByBlock.current.set(b.id, tid);
    }
    // The editor must always hold ≥1 block; fall back to an empty paragraph.
    const next: PartialBlock[] = blocks.length > 0 ? blocks : [{ type: "paragraph" }];
    editor.replaceBlocks(editor.document, next);
  };

  // Seed once, when the first plan data arrives. The 4s poll never re-seeds (it
  // would clobber an in-progress edit); use Reload to pull a fresh copy by hand.
  // `seed` is re-created each render (it closes over the editor); a ref keeps the
  // effect keyed on data availability alone rather than that changing identity.
  const seedRef = useRef(seed);
  seedRef.current = seed;
  useEffect(() => {
    if (seeded.current || idx.goals.length === 0) return;
    seedRef.current();
    seeded.current = true;
  }, [idx]);

  // The nearest milestone heading above a block — where a new task line belongs.
  const milestoneOf = (blockId: string): number | null => {
    let ms: number | null = null;
    for (const b of editor.document) {
      const m = decode("m-", b.id);
      if (m != null) ms = m;
      if (b.id === blockId) return ms;
    }
    return ms;
  };

  // Ensure the block at the cursor is a saved task, creating it under its milestone
  // if it's a fresh line. Returns the task id, or null if it can't be placed.
  const ensureTask = async (block: Block): Promise<number | null> => {
    const text = blockText(block);
    if (!text) return null;
    const existing = taskByBlock.current.get(block.id);
    if (existing != null) {
      await api.tasks({ id: existing }).patch({ title: text });
      return existing;
    }
    const milestoneId = milestoneOf(block.id);
    if (milestoneId == null) {
      setError("put this line under a milestone before launching it");
      return null;
    }
    const { data, error } = await api.tasks.post({ milestoneId, title: text });
    if (error || !data) {
      setError(error ? String(error.value ?? error.status) : "create failed");
      return null;
    }
    const created = data as unknown as Task;
    taskByBlock.current.set(block.id, created.id);
    return created.id;
  };

  // Launch the line at the cursor: create it if new, start a session, and drop it
  // from the backlog (it's Active now). Powers both "launch a backlog item" and
  // "exec-now on a freshly typed line" — same gesture.
  const launch = async (kind: "local" | "remote") => {
    const block = editor.getTextCursorPosition().block;
    const taskId = await ensureTask(block);
    if (taskId == null) return;
    if (kind === "remote") await dispatch(taskId);
    else await startLocal(taskId);
    editor.removeBlocks([block.id]);
    taskByBlock.current.delete(block.id);
  };

  // Persist text edits without launching: rename headings/tasks and create any
  // new task lines. New items default to the backlog (no session) — that's Save.
  const save = async () => {
    let currentMs: number | null = null;
    for (const b of editor.document) {
      const text = blockText(b);
      const gid = decode("g-", b.id);
      const mid = decode("m-", b.id);
      if (gid != null) {
        if (text) await api.goals({ id: gid }).patch({ title: text });
        continue;
      }
      if (mid != null) {
        currentMs = mid;
        if (text) await api.milestones({ id: mid }).patch({ title: text });
        continue;
      }
      if (b.type !== "checkListItem" || !text) continue;
      const existing = taskByBlock.current.get(b.id);
      if (existing != null) {
        await api.tasks({ id: existing }).patch({ title: text });
      } else if (currentMs != null) {
        const { data } = await api.tasks.post({ milestoneId: currentMs, title: text });
        if (data) taskByBlock.current.set(b.id, (data as unknown as Task).id);
      }
    }
    await refresh();
  };

  const reload = () => {
    seed();
    seeded.current = true;
  };

  const launchItems = (): DefaultReactSuggestionItem[] => [
    {
      title: "Start local",
      subtext: "Create (if new) and start a local worktree session — moves to Active",
      group: "Launch",
      aliases: ["local", "exec", "run", "start"],
      onItemClick: () => void launch("local"),
    },
    {
      title: "Dispatch remote",
      subtext: "Create (if new) and dispatch a claude --remote session — moves to Active",
      group: "Launch",
      aliases: ["remote", "dispatch", "cloud"],
      onItemClick: () => void launch("remote"),
    },
  ];

  return (
    <Box
      style={{ height: "100%", display: "flex", flexDirection: "column", background: "#1a1b1e" }}
    >
      <Group justify="space-between" px="md" py={8} style={{ flex: "0 0 auto" }}>
        <Group gap={8}>
          <Text size="xs" c="dimmed" fw={700} style={{ letterSpacing: 0.5 }}>
            BACKLOG
          </Text>
          {loading && (
            <Text size="xs" c="dimmed">
              loading…
            </Text>
          )}
        </Group>
        <Group gap={6}>
          <Button size="compact-xs" variant="light" onClick={() => void save()}>
            Save
          </Button>
          <Button size="compact-xs" variant="subtle" color="gray" onClick={reload}>
            Reload
          </Button>
        </Group>
      </Group>

      {lastStart && (
        <Box px="md" pb={8} style={{ flex: "0 0 auto" }}>
          <Group justify="space-between" mb={4}>
            <Text size="sm" fw={600}>
              Local session ready · {lastStart.branch}
            </Text>
            <Button size="compact-xs" variant="subtle" color="gray" onClick={dismissStart}>
              dismiss
            </Button>
          </Group>
          <Text size="xs" c="dimmed">
            Worktree: <Code>{lastStart.worktreePath}</Code>
          </Text>
          <CopyButton value={lastStart.prompt}>
            {({ copied, copy }) => (
              <Button size="compact-xs" mt={4} variant="light" onClick={copy}>
                {copied ? "copied" : "copy prompt"}
              </Button>
            )}
          </CopyButton>
        </Box>
      )}

      <Box style={{ flex: 1, overflowY: "auto" }}>
        <BlockNoteView editor={editor} theme="dark" slashMenu={false}>
          <SuggestionMenuController
            triggerCharacter="/"
            getItems={async (query) =>
              filterSuggestionItems(
                [...launchItems(), ...getDefaultReactSlashMenuItems(editor)],
                query,
              )
            }
          />
        </BlockNoteView>
      </Box>
    </Box>
  );
}
