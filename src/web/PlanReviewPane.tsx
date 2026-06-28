import { ActionIcon, Box, Button, Group, SegmentedControl, Select, Text } from "@mantine/core";
import type { DiffLineAnnotation } from "@pierre/diffs/react";
import { MultiFileDiff } from "@pierre/diffs/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./client.ts";
import { type Hunk, computeHunks, hunkAt, revertHunk } from "./plan-md-diff.ts";

// Review the plan as markdown, with the same @pierre/diffs renderer the PR review
// uses. The baseline is the live plan (GET /plan/markdown); the draft is what you're
// proposing — seeded from the current plan or from a pending proposal's projection
// (GET /proposals/:id/markdown). The diff between them is the review surface, and each
// changed hunk carries a gutter "revert" so you can drop individual changes without
// hand-editing the text. "Apply" writes the curated draft back through the markdown
// roundtrip (POST /plan/markdown), which reconciles it into the live plan.

type View = "split" | "unified";
type ASide = "additions" | "deletions";
type Meta = { hunk: number };

const DIFF_THEME = "github-dark";
const FILE = "plan.md";
const CURRENT = "current";

type Pending = { id: number; title: string };

export function PlanReviewPane() {
  const [baseline, setBaseline] = useState("");
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<Pending[]>([]);
  const [source, setSource] = useState<string>(CURRENT);
  const [view, setView] = useState<View>("unified");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load the live plan + the pending-proposal list. Only resets the draft to the
  // baseline while you're on the "current plan" source, so a reload (or the apply
  // refresh) never clobbers a proposal draft you're curating.
  const load = useCallback(async () => {
    const [plan, props] = await Promise.all([api.plan.markdown.get(), api.proposals.pending.get()]);
    const md = typeof plan.data === "string" ? plan.data : "";
    setBaseline(md);
    setSource((s) => {
      if (s === CURRENT) setDraft(md);
      return s;
    });
    setPending(
      ((props.data ?? []) as Array<{ id: number; title: string }>).map((p) => ({
        id: p.id,
        title: p.title,
      })),
    );
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Switch what the draft is compared from: the current plan (no diff until you edit
  // /revert nothing), or a pending proposal projected onto the live plan.
  const chooseSource = async (val: string | null) => {
    const next = val ?? CURRENT;
    setSource(next);
    setStatus(null);
    setError(null);
    if (next === CURRENT) {
      setDraft(baseline);
      return;
    }
    const { data } = await api.proposals({ id: Number(next) }).markdown.get();
    setDraft(typeof data === "string" ? data : baseline);
  };

  const hunks = useMemo(() => computeHunks(baseline, draft), [baseline, draft]);
  const dirty = hunks.length > 0;

  const revert = useCallback((h: Hunk) => setDraft((d) => revertHunk(baseline, d, h)), [baseline]);

  const apply = async () => {
    setBusy(true);
    setError(null);
    setStatus(null);
    const { data, error: err } = await api.plan.markdown.post({ markdown: draft });
    if (err) {
      setError(String((err.value as { error?: string })?.error ?? err.status));
    } else if (data) {
      const r = data as { created: number; updated: number; archived: number };
      setStatus(`applied — +${r.created} created · ${r.updated} updated · ${r.archived} archived`);
      setSource(CURRENT);
      await load();
    }
    setBusy(false);
  };

  // One annotation per hunk, anchored at its first changed line — a guaranteed-visible
  // "revert" chip even where the gutter hover affordance isn't reachable.
  const annotations: DiffLineAnnotation<Meta>[] = useMemo(
    () =>
      hunks.map((h, i) => ({
        side: (h.newCount > 0 ? "additions" : "deletions") as ASide,
        lineNumber: h.newCount > 0 ? h.newStart : h.oldStart,
        metadata: { hunk: i },
      })),
    [hunks],
  );

  const renderAnnotation = (ann: DiffLineAnnotation<Meta>) => {
    const h = hunks[ann.metadata.hunk];
    if (!h) return null;
    return (
      <Group gap={6} px="sm" py={2} style={{ borderTop: "1px solid #2c2e33" }}>
        <Button size="compact-xs" variant="subtle" color="orange" onClick={() => revert(h)}>
          ↺ revert this change
        </Button>
      </Group>
    );
  };

  // The gutter affordance from the screenshot: hovering a changed line shows a revert
  // control right in the gutter. Reads the live hovered line at click time.
  const renderGutterUtility = (
    getHoveredLine: () => { lineNumber: number; side: ASide } | undefined,
  ) => {
    const hovered = getHoveredLine();
    if (!hovered) return null;
    const h = hunkAt(hunks, hovered.side, hovered.lineNumber);
    if (!h) return null;
    return (
      <ActionIcon
        size="xs"
        variant="filled"
        color="orange"
        title="Revert this change"
        aria-label="Revert this change"
        onClick={() => revert(h)}
      >
        ↺
      </ActionIcon>
    );
  };

  return (
    <Box
      style={{ height: "100%", display: "flex", flexDirection: "column", background: "#1a1b1e" }}
    >
      <Group justify="space-between" px="md" py={8} style={{ flex: "0 0 auto" }} wrap="nowrap">
        <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
          <Text size="xs" c="dimmed" fw={700} style={{ letterSpacing: 0.5 }}>
            PLAN REVIEW
          </Text>
          <Select
            size="xs"
            w={240}
            value={source}
            onChange={chooseSource}
            data={[
              { value: CURRENT, label: "Current plan (no changes)" },
              ...pending.map((p) => ({ value: String(p.id), label: `P${p.id} · ${p.title}` })),
            ]}
            aria-label="Compare against"
          />
          {error && (
            <Text size="xs" c="red" truncate maw={280} title={error}>
              {error}
            </Text>
          )}
          {status && (
            <Text size="xs" c="teal" truncate maw={320}>
              {status}
            </Text>
          )}
        </Group>
        <Group gap={6} wrap="nowrap">
          <SegmentedControl
            size="xs"
            value={view}
            onChange={(v) => setView(v as View)}
            data={[
              { label: "Unified", value: "unified" },
              { label: "Split", value: "split" },
            ]}
          />
          <Button
            size="compact-xs"
            color="green"
            variant="light"
            loading={busy}
            disabled={busy || !dirty}
            onClick={apply}
          >
            Apply to plan
          </Button>
        </Group>
      </Group>

      <Box style={{ flex: 1, overflowY: "auto" }}>
        {!dirty ? (
          <Text c="dimmed" size="sm" px="md" py="lg">
            No changes to review. Pick a pending proposal to see it as a diff against the live plan,
            then revert any change you don't want and Apply the rest.
          </Text>
        ) : (
          <MultiFileDiff<Meta>
            oldFile={{ name: FILE, contents: baseline }}
            newFile={{ name: FILE, contents: draft }}
            disableWorkerPool
            lineAnnotations={annotations}
            renderAnnotation={renderAnnotation}
            renderGutterUtility={renderGutterUtility}
            options={{
              diffStyle: view,
              theme: DIFF_THEME,
              themeType: "dark",
              disableFileHeader: true,
            }}
          />
        )}
      </Box>
    </Box>
  );
}
