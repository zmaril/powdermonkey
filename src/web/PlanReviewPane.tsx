import { ActionIcon, Box, Button, Group, SegmentedControl, Select, Text } from "@mantine/core";
import type { DiffLineAnnotation } from "@pierre/diffs/react";
import { MultiFileDiff } from "@pierre/diffs/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./client.ts";
import { type Hunk, applySelection, computeHunks, hunkAt } from "./plan-md-diff.ts";

// Review the plan as markdown, with the same @pierre/diffs renderer the PR review
// uses. The baseline is the live plan (GET /plan/markdown); the "proposed" side is a
// pending proposal projected onto it (GET /proposals/:id/markdown). The diff between
// them shows every change, and each hunk is independently accepted or reverted from
// the gutter — `+` to take a change, `↺` to drop it. "Apply" writes only the accepted
// subset back through the markdown roundtrip (POST /plan/markdown), which reconciles
// it into the live plan.

type View = "split" | "unified";
type ASide = "additions" | "deletions";
type Meta = { hunk: number };

const DIFF_THEME = "github-dark";
const FILE = "plan.md";
const CURRENT = "current";

type Pending = { id: number; title: string };

export function PlanReviewPane() {
  const [baseline, setBaseline] = useState("");
  const [proposed, setProposed] = useState("");
  const [pending, setPending] = useState<Pending[]>([]);
  const [source, setSource] = useState<string>(CURRENT);
  const [view, setView] = useState<View>("unified");
  // Which hunks are accepted (taken from the proposed side). A hunk not in the set
  // is reverted to the baseline. The displayed diff always shows the full proposal so
  // every change stays toggleable; this set is what Apply actually composes.
  const [accepted, setAccepted] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load the live plan + the pending-proposal list. Only resets the proposed side to
  // the baseline while you're on the "current plan" source, so a reload (or the apply
  // refresh) never clobbers a proposal you're curating.
  const load = useCallback(async () => {
    const [plan, props] = await Promise.all([api.plan.markdown.get(), api.proposals.pending.get()]);
    const md = typeof plan.data === "string" ? plan.data : "";
    setBaseline(md);
    setSource((s) => {
      if (s === CURRENT) setProposed(md);
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

  // Switch what's reviewed: the current plan (no changes), or a pending proposal
  // projected onto the live plan.
  const chooseSource = async (val: string | null) => {
    const next = val ?? CURRENT;
    setSource(next);
    setStatus(null);
    setError(null);
    if (next === CURRENT) {
      setProposed(baseline);
      return;
    }
    const { data } = await api.proposals({ id: Number(next) }).markdown.get();
    setProposed(typeof data === "string" ? data : baseline);
  };

  const hunks = useMemo(() => computeHunks(baseline, proposed), [baseline, proposed]);

  // A freshly-loaded proposal starts fully accepted — you review by dropping the bits
  // you don't want (and can re-accept any). Resets whenever the change-set changes.
  useEffect(() => {
    setAccepted(new Set(hunks.map((_, i) => i)));
  }, [hunks]);

  const toggle = useCallback(
    (i: number, on: boolean) =>
      setAccepted((prev) => {
        const next = new Set(prev);
        if (on) next.add(i);
        else next.delete(i);
        return next;
      }),
    [],
  );

  const result = useMemo(
    () => applySelection(baseline, proposed, hunks, accepted),
    [baseline, proposed, hunks, accepted],
  );
  const hasChanges = hunks.length > 0;
  const willChange = result !== baseline;

  const apply = async () => {
    setBusy(true);
    setError(null);
    setStatus(null);
    const { data, error: err } = await api.plan.markdown.post({ markdown: result });
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

  // One annotation per hunk, at its first changed line — a guaranteed-visible accept/
  // revert control even where the gutter hover affordance isn't reachable.
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
    const i = ann.metadata.hunk;
    if (!hunks[i]) return null;
    const on = accepted.has(i);
    return (
      <Group gap={8} px="sm" py={2} style={{ borderTop: "1px solid #2c2e33" }}>
        <Text size="xs" c={on ? "teal" : "dimmed"} fw={600}>
          {on ? "✓ accepted" : "○ reverted"}
        </Text>
        {on ? (
          <Button
            size="compact-xs"
            variant="subtle"
            color="orange"
            onClick={() => toggle(i, false)}
          >
            ↺ revert this change
          </Button>
        ) : (
          <Button size="compact-xs" variant="subtle" color="green" onClick={() => toggle(i, true)}>
            + accept this change
          </Button>
        )}
      </Group>
    );
  };

  // The gutter affordance: hovering a changed line shows the contextual toggle — `+`
  // to accept a reverted change, `↺` to revert an accepted one. Reads the live hovered
  // line at click time.
  const renderGutterUtility = (
    getHoveredLine: () => { lineNumber: number; side: ASide } | undefined,
  ) => {
    const hovered = getHoveredLine();
    if (!hovered) return null;
    const idx = hunks.findIndex((h) => h === hunkAt(hunks, hovered.side, hovered.lineNumber));
    if (idx < 0) return null;
    const on = accepted.has(idx);
    return (
      <ActionIcon
        size="xs"
        variant="filled"
        color={on ? "orange" : "green"}
        title={on ? "Revert this change" : "Accept this change"}
        aria-label={on ? "Revert this change" : "Accept this change"}
        onClick={() => toggle(idx, !on)}
      >
        {on ? "↺" : "+"}
      </ActionIcon>
    );
  };

  const acceptedCount = hunks.reduce((n, _h, i) => n + (accepted.has(i) ? 1 : 0), 0);

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
          {hasChanges && (
            <Text size="xs" c="dimmed">
              {acceptedCount}/{hunks.length} accepted
            </Text>
          )}
          {error && (
            <Text size="xs" c="red" truncate maw={260} title={error}>
              {error}
            </Text>
          )}
          {status && (
            <Text size="xs" c="teal" truncate maw={300}>
              {status}
            </Text>
          )}
        </Group>
        <Group gap={6} wrap="nowrap">
          {hasChanges && (
            <>
              <Button
                size="compact-xs"
                variant="subtle"
                color="green"
                onClick={() => setAccepted(new Set(hunks.map((_, i) => i)))}
              >
                Accept all
              </Button>
              <Button
                size="compact-xs"
                variant="subtle"
                color="orange"
                onClick={() => setAccepted(new Set())}
              >
                Revert all
              </Button>
            </>
          )}
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
            disabled={busy || !willChange}
            onClick={apply}
          >
            Apply to plan
          </Button>
        </Group>
      </Group>

      <Box style={{ flex: 1, overflowY: "auto" }}>
        {!hasChanges ? (
          <Text c="dimmed" size="sm" px="md" py="lg">
            No changes to review. Pick a pending proposal to see it as a diff against the live plan,
            then accept (+) or revert (↺) each change in the gutter and Apply the accepted set.
          </Text>
        ) : (
          <MultiFileDiff<Meta>
            oldFile={{ name: FILE, contents: baseline }}
            newFile={{ name: FILE, contents: proposed }}
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
